# Streaming Task Queue 设计文档

## 1. 背景与动机

### 现状

当前 argus 的 LLM 调用分布在不同阶段，但只有 **Agent 执行阶段** 使用了 `task-scheduler`（`runTasks`），其他阶段的 LLM 调用各自处理并发和重试：

| 阶段              | LLM 调用                             | 并发控制                  | 重试            | 限流处理       |
| ----------------- | ------------------------------------ | ------------------------- | --------------- | -------------- |
| Agent 执行        | `runTasks` + `pLimit`                | ✅ 全局 concurrency       | ✅ 指数退避     | ✅ Retry-After |
| 实时去重          | `Anthropic.messages.create`          | ❌ 串行（processingLock） | ❌ 失败直接接受 | ❌ 无          |
| 流式验证          | `StreamingValidator` 自管理          | ⚠️ session 级并发         | ❌ 无           | ❌ 无          |
| 自定义 Agent 匹配 | `selectAgents` / `matchCustomAgents` | ❌ 单次调用               | ❌ 无           | ❌ 无          |

**核心问题**：

1. **并发浪费**：Agent 阶段结束后，validation/dedup 阶段没有共享并发池，API 配额未被充分利用
2. **重试不一致**：去重和验证阶段遇到 429/网络错误时没有重试，直接降级
3. **架构割裂**：每个阶段独立管理 LLM 调用，无法统一监控和调度

### 目标

设计一个 **Streaming Task Queue**，具备：

- 接受初始任务队列，且**允许运行时动态追加任务**
- 统一的并发控制、重试、限流处理
- 让 Agent 执行、去重、验证等阶段共享同一个调度器
- 充分利用 API 并发配额，避免阶段间的空闲

## 2. 核心设计

### 2.1 接口定义

```typescript
// src/task-scheduler/streaming-task-queue.ts

/**
 * 流式任务队列 — 支持运行时动态追加任务的调度器
 *
 * 与 runTasks 的关键区别：
 * - runTasks: 接受固定的 Task[]，一次性执行完毕
 * - StreamingTaskQueue: 接受初始队列 + 运行时 push，持续调度直到 close()
 */
export class StreamingTaskQueue<T = unknown> {
  constructor(options?: StreamingQueueOptions);

  /** 追加任务到队列（可在调度开始后随时调用） */
  push(task: Task<T>): TaskHandle<T>;

  /** 批量追加任务 */
  pushMany(tasks: Task<T>[]): TaskHandle<T>[];

  /** 关闭队列：不再接受新任务，等待已入队任务完成 */
  close(): Promise<QueueResult<T>>;

  /** 当前队列状态快照 */
  getStats(): QueueStats;

  /** 取消所有待执行任务 */
  abort(): void;
}

/** 单个任务的句柄，可用于追踪结果 */
export interface TaskHandle<T> {
  /** 任务在队列中的序号 */
  id: number;
  /** 等待任务完成并获取结果 */
  result(): Promise<TaskResult<T>>;
}

/** 队列选项 */
export interface StreamingQueueOptions {
  /** 最大并发数（默认 5） */
  concurrency?: number;
  /** 重试策略（复用现有 RetryConfig） */
  retry?: PartialRetryConfig;
  /** 错误分类器 */
  errorClassifier?: ErrorClassifier;
  /** 事件回调 */
  onEvent?: QueueEventCallback;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 队列级事件回调 */
export type QueueEventCallback = (event: QueueEvent) => void | Promise<void>;

/** 队列事件（扩展自 SchedulerEvent，增加队列级事件） */
export type QueueEvent =
  | SchedulerEvent
  | { type: 'queue-drain'; pendingCount: 0; completedCount: number }
  | { type: 'queue-close'; totalPushed: number; completedCount: number };

/** 队列统计 */
export interface QueueStats {
  /** 已 push 的总任务数 */
  totalPushed: number;
  /** 已完成的任务数 */
  completedCount: number;
  /** 当前正在执行的任务数 */
  activeCount: number;
  /** 队列中等待执行的任务数 */
  pendingCount: number;
}
```

### 2.2 核心调度循环

```
┌──────────────────────────────────────────┐
│           StreamingTaskQueue             │
│                                          │
│  ┌─────────┐    ┌──────────────────┐     │
│  │ push()  │───▶│   pendingQueue   │     │
│  └─────────┘    └────────┬─────────┘     │
│                          │               │
│                    ┌─────▼─────┐         │
│                    │  pLimit   │         │
│                    │ (concurrency)│      │
│                    └─────┬─────┘         │
│                          │               │
│              ┌───────────┼───────────┐   │
│              ▼           ▼           ▼   │
│         ┌────────┐ ┌────────┐ ┌────────┐│
│         │ Task 1 │ │ Task 2 │ │ Task 3 ││
│         │(retry) │ │(retry) │ │(retry) ││
│         └───┬────┘ └───┬────┘ └───┬────┘│
│             │          │          │      │
│             ▼          ▼          ▼      │
│         ┌──────────────────────────┐    │
│         │    completedResults      │    │
│         └──────────────────────────┘    │
│                                          │
│  close() ──▶ 等待 pending + active = 0  │
└──────────────────────────────────────────┘
```

**调度循环伪代码**：

```typescript
class StreamingTaskQueue<T> {
  private pendingQueue: QueueItem<T>[] = [];
  private limit: pLimit.Limit;
  private closed = false;
  private nextId = 0;
  private activeCount = 0;
  private completedCount = 0;
  private results = new Map<number, TaskResult<T>>();

  push(task: Task<T>): TaskHandle<T> {
    if (this.closed) throw new Error('Queue is closed');
    const id = this.nextId++;
    const item = { id, task, resolveResult: null };
    this.pendingQueue.push(item);

    const handle: TaskHandle<T> = {
      id,
      result: () =>
        new Promise((resolve) => {
          item.resolveResult = resolve;
        }),
    };

    this.scheduleNext(); // 尝试立即调度
    return handle;
  }

  private scheduleNext(): void {
    while (this.pendingQueue.length > 0 && this.limit.pendingCount < this.limit.concurrency) {
      const item = this.pendingQueue.shift()!;
      this.limit(() => this.executeItem(item));
    }
  }

  private async executeItem(item: QueueItem<T>): Promise<void> {
    this.activeCount++;
    try {
      const result = await executeTaskWithRetry({
        task: item.task,
        index: item.id,
        ...this.retryConfig,
        onEvent: this.onEvent,
        signal: this.signal,
      });
      this.results.set(item.id, result);
      item.resolveResult?.(result);
      this.completedCount++;
    } finally {
      this.activeCount--;
      this.scheduleNext(); // 完成后尝试调度更多
    }
  }

  async close(): Promise<QueueResult<T>> {
    this.closed = true;
    // 等待所有 pending + active 任务完成
    await this.waitForCompletion();
    return this.buildResult();
  }
}
```

### 2.3 与现有 `runTasks` 的关系

```
runTasks (现有)              StreamingTaskQueue (新增)
─────────────────            ──────────────────────────
一次性 Task[]                push() 动态追加
Promise.all 等待             close() 等待
结果按 index 排序            结果通过 TaskHandle.result() 获取
适合已知全部任务的场景        适合任务流式产生的场景

底层共享：
- executeTaskWithRetry()
- RetryConfig / normalizeRetryConfig()
- ErrorClassifier
- SchedulerEvent 体系
```

**不替代 `runTasks`**：`runTasks` 作为简单的一次性执行 API 保留，`StreamingTaskQueue` 是更高层的抽象。

## 3. 在 argus 中的集成方案

### 3.1 当前流程 vs 目标流程

**当前流程**（阶段串行，各自管理 LLM 调用）：

```
Phase 1: 上下文构建
Phase 2: Agent 执行 ──── runTasks(agents) ──── 并发控制 ✅ 重试 ✅
Phase 3: 验证等待 ──── StreamingValidator.flush() ── 并发 ⚠️ 重试 ❌
         (去重穿插在 Phase 2 的 MCP 回调中) ── 串行 ❌ 重试 ❌
Phase 4: 聚合输出
```

**目标流程**（共享调度器，持续利用并发）：

```
Phase 1: 上下文构建
         ↓ 创建 StreamingTaskQueue(concurrency=2)
Phase 2: push(agent tasks) ──────────────────┐
         ↓ (agents 运行中，通过 MCP 回调)      │
         push(dedup tasks) ──────────────────┤ 共享并发池
         ↓ (去重通过后)                        │
         push(validation tasks) ─────────────┤
         ↓                                     │
Phase 3: queue.close() ─────────────────────┘ 等待全部完成
Phase 4: 聚合输出
```

### 3.2 具体改造点

#### 3.2.1 Agent 执行 → push agent tasks

```typescript
// 改造前
const outcomes = await this.runAgentTasks(specs, { concurrency, ... });

// 改造后
const agentHandles = specs.map(spec => queue.push(async (ctx) => {
  return this.runStreamingAgent(spec.agentType, ...);
}));
```

#### 3.2.2 实时去重 → push dedup tasks

```typescript
// 改造前 (realtime-deduplicator.ts)
// 使用 processingLock 串行 + 直接 Anthropic SDK 调用
async checkAndAdd(issue) {
  this.processingLock = this.processingLock.then(async () => {
    result = await this.checkAndAddImpl(issue);  // 直接调用 Anthropic SDK
  });
}

// 改造后
// dedup 任务通过 queue 调度，共享并发池
async checkAndAdd(issue) {
  const potentialDuplicates = this.findPotentialDuplicates(issue);
  if (potentialDuplicates.length === 0) {
    this.acceptedIssues.push(issue);
    return { isDuplicate: false };
  }
  // 将 LLM 调用作为任务 push 到队列
  const handle = queue.push(async () => this.checkWithLLM(issue, potentialDuplicates));
  const llmResult = await handle.result();
  // ... 处理结果
}
```

#### 3.2.3 流式验证 → push validation tasks

```typescript
// 改造前 (streaming-validator.ts)
// 每个文件 session 自行管理并发，直接调用 Anthropic SDK
startSessionProcessing(session) {
  session.processingPromise = this.processSession(session);  // 内部直接调用 SDK
}

// 改造后
// validation 的 LLM 调用通过 queue 调度
processValidationRound(issue) {
  const handle = queue.push(async () => this.callValidatorLLM(issue));
  return handle.result();
}
```

### 3.3 并发利用率对比

假设 `concurrency = 2`，4 个 agent，每个 agent 产生 2 个 issue 需要去重+验证：

**当前**：

```
Agent1 ──████████████████──┐
Agent2 ──████████████████──┤ 并发=2
                           ├─ 空闲 ─┤
Dedup  ────────────────────████████──┤ 串行
Valid  ──────────────────────────────████████████──┘ session并发=5 但无重试
```

**目标**：

```
Agent1 ──████████████████──┐
Agent2 ──████████████████──┤ 并发=2
         ↓ agent1 完成 issue  │
Dedup1 ──────────████──┤    │  ← 复用 agent1 释放的并发位
Dedup2 ──────────────████──┤
Valid1 ────────────────████──┤  ← 去重完成后立即验证
Valid2 ──────────────────████──┤
```

并发位始终被充分利用，不再有阶段间的空闲。

## 4. 实现计划

### Phase 1：StreamingTaskQueue 核心实现

| 文件                                                | 内容                                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `src/task-scheduler/streaming-task-queue.ts`        | 核心类实现                                                      |
| `src/task-scheduler/types.ts`                       | 新增 `StreamingQueueOptions`, `TaskHandle`, `QueueEvent` 等类型 |
| `src/task-scheduler/index.ts`                       | 导出新 API                                                      |
| `tests/task-scheduler/streaming-task-queue.test.ts` | 单元测试                                                        |

### Phase 2：集成到 orchestrator

| 文件                                   | 改造                                            |
| -------------------------------------- | ----------------------------------------------- |
| `src/review/streaming-orchestrator.ts` | 创建 `StreamingTaskQueue`，替换 `runTasks` 调用 |
| `src/review/realtime-deduplicator.ts`  | LLM 调用改为通过 queue push                     |
| `src/review/streaming-validator.ts`    | LLM 调用改为通过 queue push                     |

### Phase 3：优化与监控

| 内容            | 说明                                            |
| --------------- | ----------------------------------------------- |
| 队列级事件      | `queue-drain`, `queue-close` 事件用于进度日志   |
| 统一 token 统计 | 从 queue 的 completed results 中汇总 token 使用 |
| 动态并发调整    | 根据限流反馈动态调整 concurrency（可选）        |

## 5. 风险与缓解

| 风险                                                   | 缓解                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 去重串行性被打破，可能导致竞态                         | 去重仍使用 `processingLock` 保证同一文件的 issue 串行检查，只是 LLM 调用走 queue  |
| 验证的 session 语义（同文件 issue 批量验证）可能被打破 | session 内部逻辑不变，仅 LLM 调用走 queue；session 的排队逻辑保留                 |
| queue 异常导致所有阶段失败                             | queue 的重试机制覆盖 transient/rate-limit 错误；不可重试错误只影响单个任务        |
| 改造范围大                                             | Phase 1 独立于现有代码，可单独测试；Phase 2 逐步替换，先替换 agent 阶段验证可行性 |

## 6. API 使用示例

```typescript
// 创建队列
const queue = new StreamingTaskQueue({
  concurrency: 2,
  retry: {
    transient: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60000, backoffMultiplier: 2 },
    rateLimit: {
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 120000,
      backoffMultiplier: 2,
      respectRetryAfter: true,
    },
  },
  onEvent: (event) => {
    if (event.type === 'task-success') console.log(`✓ Task ${event.index} done`);
    if (event.type === 'task-retry')
      console.log(`↻ Task ${event.index} retrying (delay: ${event.retryDelayMs}ms)`);
  },
});

// Phase 2: Push agent tasks
const agentHandles = agents.map((agent) => queue.push(async () => runAgent(agent)));

// MCP 回调中 push dedup + validation tasks
mcpServer.onIssue = (issue) => {
  queue.push(async () => deduplicate(issue));
  queue.push(async () => validate(issue));
};

// Phase 3: 等待全部完成
const result = await queue.close();
console.log(`Completed: ${result.completed}/${result.totalPushed}`);
```
