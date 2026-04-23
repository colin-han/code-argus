# Task Scheduler 设计文档

> 前置文档：[task-scheduler-requirements.md](./task-scheduler-requirements.md)
>
> 本文档定义具体实现方案：模块划分、类型定义、核心流程与实现要点。

## 1. 模块结构

```
src/task-scheduler/
├── index.ts                  # 公共 API 重导出
├── types.ts                  # 类型与接口定义
├── error-classifier.ts       # 默认 isRateLimitError / extractRetryAfterMs
├── retry-policy.ts           # RetryPolicy 归一化、延迟计算
├── run-tasks.ts              # 核心 runTasks 实现
└── __tests__/
    ├── error-classifier.test.ts
    ├── retry-policy.test.ts
    └── run-tasks.test.ts
```

### 1.1 依赖图

```
index.ts ──► run-tasks.ts ──► retry-policy.ts ──► error-classifier.ts
                  │                   │
                  └──► types.ts ◄─────┘
                  │
                  └──► p-limit (外部)
```

- `types.ts` 不依赖任何其他文件，是纯类型定义
- `error-classifier.ts` 仅依赖 `types.ts`
- `retry-policy.ts` 依赖 `types.ts` 和 `error-classifier.ts`
- `run-tasks.ts` 依赖以上全部 + `p-limit`
- `index.ts` 仅负责重导出

## 2. 类型定义

### 2.1 `types.ts`

```typescript
/**
 * A task to be executed by the scheduler.
 */
export interface Task<T = unknown> {
  /** Unique identifier used for logging and mapping results. */
  id: string;
  /** Optional human-readable label. */
  label?: string;
  /**
   * The task body. May be invoked multiple times on retry.
   * @param ctx Runtime context for this invocation.
   */
  run: (ctx: TaskContext) => Promise<T>;
  /** Per-task overrides on top of scheduler-level RetryPolicy. */
  retryPolicy?: Partial<RetryPolicy>;
}

/**
 * Context passed to Task.run on each invocation.
 */
export interface TaskContext {
  /** 1-based attempt counter for THIS task. */
  attempt: number;
  /** Already-failed attempts for THIS task (normal + rate-limit). */
  totalAttempts: number;
  /** Abort signal propagated from scheduler. */
  signal?: AbortSignal;
}

/**
 * Final result for a task.
 */
export type TaskResult<T = unknown> = TaskResultSuccess<T> | TaskResultFailure;

export interface TaskResultSuccess<T> {
  id: string;
  label?: string;
  success: true;
  value: T;
  attempts: number;
  rateLimitAttempts: number;
  elapsedMs: number;
  lastRunMs: number;
}

export interface TaskResultFailure {
  id: string;
  label?: string;
  success: false;
  error: unknown;
  attempts: number;
  rateLimitAttempts: number;
  elapsedMs: number;
  lastRunMs: number;
}

/**
 * Retry behaviour configuration.
 */
export interface RetryPolicy {
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxRateLimitRetries: number;
  rateLimitBaseDelayMs: number;
  rateLimitMaxDelayMs: number;
  isRateLimitError: (error: unknown) => boolean;
  extractRetryAfterMs: (error: unknown) => number | undefined;
  isRetryableError: (error: unknown) => boolean;
}

/**
 * Options for runTasks.
 */
export interface SchedulerOptions {
  concurrency: number;
  retryPolicy?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerEvent) => void;
}

/**
 * Events emitted during task execution.
 */
export type SchedulerEvent = TaskStartEvent | TaskRetryEvent | TaskSuccessEvent | TaskFailureEvent;

export interface TaskStartEvent {
  type: 'task-start';
  taskId: string;
  label?: string;
  attempt: number;
}

export interface TaskRetryEvent {
  type: 'task-retry';
  taskId: string;
  label?: string;
  attempt: number; // attempt that just failed
  nextAttempt: number; // upcoming attempt
  error: unknown;
  delayMs: number;
  isRateLimit: boolean;
}

export interface TaskSuccessEvent {
  type: 'task-success';
  taskId: string;
  label?: string;
  attempts: number;
  elapsedMs: number;
  lastRunMs: number;
}

export interface TaskFailureEvent {
  type: 'task-failure';
  taskId: string;
  label?: string;
  attempts: number;
  error: unknown;
  elapsedMs: number;
  lastRunMs: number;
}

/**
 * Thrown when a task is aborted via AbortSignal before starting.
 */
export class TaskAbortedError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Task ${taskId} aborted before execution`);
    this.name = 'TaskAbortedError';
    this.taskId = taskId;
  }
}
```

### 2.2 默认值常量（不对外导出）

```typescript
// retry-policy.ts
const DEFAULTS: RetryPolicy = {
  maxRetries: 2,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 60_000,
  maxRateLimitRetries: 5,
  rateLimitBaseDelayMs: 30_000,
  rateLimitMaxDelayMs: 600_000,
  isRateLimitError: defaultIsRateLimitError,
  extractRetryAfterMs: defaultExtractRetryAfterMs,
  isRetryableError: () => true,
};
```

## 3. 核心流程

### 3.1 整体时序

```
runTasks(tasks, options)
  │
  ├─ 归一化 options.retryPolicy (合并默认值)
  ├─ 创建 p-limit(concurrency)
  ├─ 对每个 task 创建 Promise via limit(...)
  │    │
  │    └─ executeWithRetry(task, mergedPolicy, onEvent, signal)
  │         │
  │         ├─ 检查 signal.aborted → 立即返回 TaskAbortedError 结果
  │         ├─ while (true):
  │         │    ├─ emit task-start
  │         │    ├─ try { value = await task.run(ctx) }
  │         │    │    └─ 成功 → emit task-success → return success
  │         │    └─ catch (error):
  │         │         ├─ isRateLimit = policy.isRateLimitError(error)
  │         │         ├─ canRetry = 剩余次数 > 0 && (isRateLimit || policy.isRetryableError(error))
  │         │         ├─ if (!canRetry || signal.aborted):
  │         │         │    └─ emit task-failure → return failure
  │         │         ├─ delayMs = computeDelay(policy, isRateLimit, 次数, error)
  │         │         ├─ emit task-retry { delayMs, isRateLimit, ... }
  │         │         ├─ await sleep(delayMs, signal)  // 可被 abort 中断
  │         │         └─ continue
  │
  └─ await Promise.all(任务 promise)
       └─ 返回 TaskResult[] (顺序与输入一致)
```

### 3.2 单任务状态机

```
           ┌─────────────────────────┐
           │       START             │
           │ (attempts=0, rl=0)      │
           └──────────┬──────────────┘
                      │ emit task-start
                      ▼
              ┌──────────────┐
              │   RUNNING    │
              └──────┬───┬───┘
                success│ │ throw
                      │ │
          ┌───────────┘ └──────────────┐
          ▼                            ▼
   ┌──────────────┐            ┌────────────────┐
   │  SUCCEEDED   │            │   CLASSIFY     │
   │ emit success │            │ isRateLimit?   │
   │ return ok    │            │ canRetry?      │
   └──────────────┘            └────┬──────┬────┘
                                 yes│      │no
                                    ▼      ▼
                      ┌──────────────┐  ┌──────────────┐
                      │  WAITING     │  │  FAILED      │
                      │ sleep(delay) │  │ emit failure │
                      └──────┬───────┘  │ return err   │
                             │          └──────────────┘
                             │ signal? → abort → FAILED
                             │ else → back to RUNNING
                             └─────────────────────┐
                                                   │
                                                   ▼
                                             (loop continues)
```

### 3.3 延迟计算 `computeDelay`

```typescript
function computeDelay(
  policy: RetryPolicy,
  isRateLimit: boolean,
  failedAttempts: number, // 已失败次数（该类别下）
  error: unknown
): number {
  if (isRateLimit) {
    const retryAfter = policy.extractRetryAfterMs(error);
    const base = retryAfter ?? policy.rateLimitBaseDelayMs;
    const exp = base * Math.pow(2, failedAttempts - 1);
    return Math.min(exp, policy.rateLimitMaxDelayMs);
  } else {
    const exp = policy.retryBaseDelayMs * Math.pow(2, failedAttempts - 1);
    return Math.min(exp, policy.retryMaxDelayMs);
  }
}
```

### 3.4 可中断 sleep

为了让 `AbortSignal` 能中断正在等待的退避：

```typescript
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

## 4. 关键实现细节

### 4.1 `error-classifier.ts`

```typescript
export function defaultIsRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return e.status === 429 || e.statusCode === 429 || e.code === 429 || e.code === '429';
}

export function defaultExtractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    headers?: Record<string, string | string[] | undefined>;
    response?: { headers?: Record<string, string | string[] | undefined> };
  };
  const headers = e.headers ?? e.response?.headers;
  if (!headers) return undefined;

  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === '') return undefined;

  // Try numeric seconds first
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum >= 0) return asNum * 1000;

  // Try HTTP-date
  const ts = Date.parse(value);
  if (!Number.isNaN(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
```

### 4.2 `retry-policy.ts`

```typescript
export function normalizeRetryPolicy(override?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULTS, ...override };
}

/** Merge scheduler-level and task-level policies. */
export function mergePolicies(
  schedulerPolicy: RetryPolicy,
  taskOverride?: Partial<RetryPolicy>
): RetryPolicy {
  return taskOverride ? { ...schedulerPolicy, ...taskOverride } : schedulerPolicy;
}

export function computeDelay(
  policy: RetryPolicy,
  isRateLimit: boolean,
  failedAttempts: number,
  error: unknown
): number {
  /* 如 3.3 所示 */
}
```

### 4.3 `run-tasks.ts` 骨架

```typescript
import pLimit from 'p-limit';
import type { Task, TaskResult, SchedulerOptions /* ... */ } from './types.js';
import { normalizeRetryPolicy, mergePolicies, computeDelay } from './retry-policy.js';

export async function runTasks<T>(
  tasks: Task<T>[],
  options: SchedulerOptions
): Promise<TaskResult<T>[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }

  const basePolicy = normalizeRetryPolicy(options.retryPolicy);
  const limit = pLimit(options.concurrency);
  const signal = options.signal;
  const emit = options.onEvent;

  return Promise.all(
    tasks.map((task) => limit(() => executeWithRetry(task, basePolicy, emit, signal)))
  );
}

async function executeWithRetry<T>(
  task: Task<T>,
  basePolicy: RetryPolicy,
  emit: ((e: SchedulerEvent) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<TaskResult<T>> {
  const policy = mergePolicies(basePolicy, task.retryPolicy);
  const startedAt = Date.now();
  let lastError: unknown;
  let lastRunMs = 0;
  let normalAttempts = 0;
  let rateLimitAttempts = 0;

  // Early abort check
  if (signal?.aborted) {
    return failure(task, new TaskAbortedError(task.id), 0, 0, 0, 0);
  }

  while (true) {
    const attempt = normalAttempts + rateLimitAttempts + 1;

    emit?.({ type: 'task-start', taskId: task.id, label: task.label, attempt });

    const runStartedAt = Date.now();
    try {
      const value = await task.run({
        attempt,
        totalAttempts: attempt - 1,
        signal,
      });
      lastRunMs = Date.now() - runStartedAt;
      const elapsed = Date.now() - startedAt;

      emit?.({
        type: 'task-success',
        taskId: task.id,
        label: task.label,
        attempts: attempt,
        elapsedMs: elapsed,
        lastRunMs,
      });

      return {
        id: task.id,
        label: task.label,
        success: true,
        value,
        attempts: attempt,
        rateLimitAttempts,
        elapsedMs: elapsed,
        lastRunMs,
      };
    } catch (error) {
      lastError = error;
      lastRunMs = Date.now() - runStartedAt;

      const isRateLimit = policy.isRateLimitError(error);
      if (isRateLimit) rateLimitAttempts++;
      else normalAttempts++;

      const maxForKind = isRateLimit ? policy.maxRateLimitRetries : policy.maxRetries;
      const currentForKind = isRateLimit ? rateLimitAttempts : normalAttempts;

      const nonRetryable = !isRateLimit && !policy.isRetryableError(error);
      const exhausted = currentForKind > maxForKind;
      const aborted = signal?.aborted ?? false;

      if (nonRetryable || exhausted || aborted) {
        const elapsed = Date.now() - startedAt;
        emit?.({
          type: 'task-failure',
          taskId: task.id,
          label: task.label,
          attempts: attempt,
          error: aborted ? (signal!.reason ?? error) : error,
          elapsedMs: elapsed,
          lastRunMs,
        });
        return {
          id: task.id,
          label: task.label,
          success: false,
          error: aborted ? (signal!.reason ?? error) : error,
          attempts: attempt,
          rateLimitAttempts,
          elapsedMs: elapsed,
          lastRunMs,
        };
      }

      const delayMs = computeDelay(policy, isRateLimit, currentForKind, error);
      emit?.({
        type: 'task-retry',
        taskId: task.id,
        label: task.label,
        attempt,
        nextAttempt: attempt + 1,
        error,
        delayMs,
        isRateLimit,
      });

      try {
        await sleep(delayMs, signal);
      } catch {
        // signal aborted during sleep → treat as failure
        const elapsed = Date.now() - startedAt;
        emit?.({
          type: 'task-failure',
          taskId: task.id,
          label: task.label,
          attempts: attempt,
          error: signal?.reason ?? error,
          elapsedMs: elapsed,
          lastRunMs,
        });
        return {
          id: task.id,
          label: task.label,
          success: false,
          error: signal?.reason ?? error,
          attempts: attempt,
          rateLimitAttempts,
          elapsedMs: elapsed,
          lastRunMs,
        };
      }
    }
  }
}
```

### 4.4 Abort 行为细节

| 场景                                  | 处理                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runTasks` 调用前 signal 已 aborted   | 每个 task 在 `limit(...)` 内立即走 early-abort 分支，返回 `TaskAbortedError`                                                                                                                     |
| 某 task 等待 p-limit 调度期间 aborted | 进入 `executeWithRetry` 后的 early-abort 检查，立即返回失败                                                                                                                                      |
| task 运行中 aborted                   | `task.run` 可通过 `ctx.signal` 提前感知；若 task 忽略 signal 正常抛错，走正常重试逻辑；若 task 响应 signal 抛出 AbortError，走错误流程，可能仍被判定为可重试 — 由 `policy.isRetryableError` 控制 |
| 退避等待中 aborted                    | `sleep()` 拒绝 Promise，进入 catch 分支，立即返回失败                                                                                                                                            |

### 4.5 `index.ts`

```typescript
export { runTasks } from './run-tasks.js';
export { defaultIsRateLimitError, defaultExtractRetryAfterMs } from './error-classifier.js';
export type {
  Task,
  TaskContext,
  TaskResult,
  TaskResultSuccess,
  TaskResultFailure,
  RetryPolicy,
  SchedulerOptions,
  SchedulerEvent,
  TaskStartEvent,
  TaskRetryEvent,
  TaskSuccessEvent,
  TaskFailureEvent,
} from './types.js';
export { TaskAbortedError } from './types.js';
```

## 5. 测试策略

### 5.1 测试技术栈

- **vitest** 运行测试
- **vi.useFakeTimers()** 配合 `vi.advanceTimersByTimeAsync()` 推进时间，避免真实等待
- 每个 `.test.ts` 文件独立启动/清理 fake timers

### 5.2 测试用例列表

#### `error-classifier.test.ts`

- isRateLimitError: `{ status: 429 }` → true
- isRateLimitError: `{ statusCode: 429 }` → true
- isRateLimitError: `{ code: 429 }` / `{ code: '429' }` → true
- isRateLimitError: `{ status: 500 }` → false
- isRateLimitError: 字符串 / null / undefined → false
- isRateLimitError: **不**依赖消息关键词
- extractRetryAfterMs: `headers['retry-after'] = '120'` → 120000
- extractRetryAfterMs: `headers['Retry-After'] = '60'` (大小写) → 60000
- extractRetryAfterMs: HTTP-date → 正确毫秒差
- extractRetryAfterMs: 过期 HTTP-date → 0
- extractRetryAfterMs: 数组形式 `['30']` → 30000
- extractRetryAfterMs: 无 headers → undefined
- extractRetryAfterMs: 无效值 `"abc"` → undefined
- extractRetryAfterMs: 嵌套 `response.headers` → 正确解析

#### `retry-policy.test.ts`

- normalizeRetryPolicy: 空入参 → 所有默认值
- normalizeRetryPolicy: 部分覆盖 → 只覆盖传入字段
- mergePolicies: task override 覆盖 scheduler policy
- computeDelay: 瞬态错误指数序列 (base=2000) → 2000, 4000, 8000...
- computeDelay: 瞬态错误受 retryMaxDelayMs 截断
- computeDelay: 限流错误无 Retry-After → base=30000 指数序列
- computeDelay: 限流错误 Retry-After=60s → base=60000 指数序列
- computeDelay: 限流错误 Retry-After=0 → base=0 → delay=0
- computeDelay: 限流错误受 rateLimitMaxDelayMs 截断

#### `run-tasks.test.ts`

- 基本：1 个任务成功 → success 结果，attempts=1
- 并发：10 个任务 concurrency=3，用计数器断言峰值 ≤ 3
- 顺序：结果数组顺序与输入一致（无论完成顺序）
- 瞬态重试：任务前 2 次抛 Error，第 3 次成功 → attempts=3, success=true
- 瞬态重试耗尽：每次都抛 → attempts=3 (1+2), success=false
- 限流重试：抛 `{ status: 429 }` 5 次后成功 → rateLimitAttempts=5, success=true
- 限流退避时序：使用 fake timer 验证 sleep 被调用了 30s, 60s, 120s
- 限流 Retry-After 覆盖 base：`headers['retry-after']='60'` → 验证首次等待 60s
- 混合：3 任务中 2 成功 1 失败 → 返回 3 个结果
- AbortSignal 启动前 abort → 所有任务 success=false 且 error 为 TaskAbortedError（或 signal.reason）
- AbortSignal 运行中 abort → 正在执行的任务收到 signal；未启动的任务立即失败
- AbortSignal 退避中 abort → 任务立即失败，不再重试
- 事件顺序：start → retry → start → success（字段完整）
- 单任务 retryPolicy override 生效
- 自定义 isRetryableError 返回 false → 不重试非限流错误
- 自定义 isRateLimitError → 改变分类行为
- concurrency 非法值（0 / -1 / 非整数）抛 TypeError

### 5.3 Fake timer 示例

```typescript
it('retries with exponential backoff on rate limit', async () => {
  vi.useFakeTimers();

  let calls = 0;
  const task: Task<string> = {
    id: 't1',
    run: async () => {
      calls++;
      if (calls < 3) {
        const err: any = new Error('Too many requests');
        err.status = 429;
        throw err;
      }
      return 'ok';
    },
  };

  const events: SchedulerEvent[] = [];
  const promise = runTasks([task], {
    concurrency: 1,
    onEvent: (e) => events.push(e),
  });

  // 首次失败 + 第一次 retry (30s)
  await vi.advanceTimersByTimeAsync(30_000);
  // 第二次失败 + 第二次 retry (60s)
  await vi.advanceTimersByTimeAsync(60_000);
  // 第三次成功

  const results = await promise;
  expect(results[0].success).toBe(true);
  expect(results[0].attempts).toBe(3);
  expect(results[0].rateLimitAttempts).toBe(2);

  const retries = events.filter((e) => e.type === 'task-retry');
  expect(retries).toHaveLength(2);
  expect(retries[0].delayMs).toBe(30_000);
  expect(retries[1].delayMs).toBe(60_000);

  vi.useRealTimers();
});
```

## 6. 接入改造计划

需求文档与设计文档确认、模块实现 + 单测通过后，按以下顺序接入：

### 阶段 1：`streaming-orchestrator.ts` 重构

1. 删除本地 `runAgentWithRetry` 方法
2. 删除本地 `isRateLimitError` / `extractRetryAfterMs` 辅助函数
3. `runAgentsWithStreaming` 改为：

   ```typescript
   const tasks: Task<{ tokensUsed: number; checklists: ChecklistItem[] }>[] =
     agentsToRun.map((agentType) => ({
       id: agentType,
       label: agentType,
       run: () => this.runStreamingAgent(agentType, context, ...),
     }));

   const results = await runTasks(tasks, {
     concurrency: this.options.maxConcurrency ?? 2,
     signal: this.options.abortController?.signal,
     onEvent: (e) => this.mapSchedulerEventToProgress(e),
   });
   ```

4. `runSegmentedReview` 同样改造：展平 (segment, agent) 组合为 `Task[]`，调用 `runTasks`
5. 新增 `mapSchedulerEventToProgress` 私有方法，把 SchedulerEvent 映射到 `this.progress.*`

### 阶段 2：常量清理

- 从 `src/review/constants.ts` 删除 `MAX_AGENT_RETRIES`、`AGENT_RETRY_DELAY_MS`、`MAX_RATE_LIMIT_RETRIES`、`RATE_LIMIT_RETRY_DELAY_MS`、`RATE_LIMIT_RETRY_MAX_DELAY_MS`（若无其他引用）
- 若需要定制重试参数，在 orchestrator 中通过 `retryPolicy` 传递

### 阶段 3：验证

- 所有单测通过（模块内 + orchestrator 层）
- 手动跑一次 review 确认行为无回归
- 观察日志：`task-retry` 事件应正确区分限流与普通错误

## 7. 潜在扩展（不在首版实现）

以下能力暂不实现，但接口设计已预留：

- **抖动（jitter）**：在延迟上添加随机扰动，避免"惊群效应"。可通过新增 `jitterRatio?: number` 配置项实现
- **任务优先级**：`Task.priority?: number` + 内部优先队列。需要替换 `p-limit` 为自研调度器
- **任务超时**：`Task.timeoutMs?: number`，超时自动 abort。需要在 `executeWithRetry` 内嵌 `setTimeout + AbortController`
- **重试事件回放**：记录每次 attempt 的完整历史（start/end/error），供后续分析

---

**请评审设计。确认无误后按顺序实施：**

1. 实现 `src/task-scheduler/` + 完整单测（`run-tasks.test.ts` 等）
2. 测试全绿后接入 `streaming-orchestrator.ts`，清理旧常量
3. 手动冒烟验证
