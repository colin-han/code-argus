# Task Scheduler 需求文档

> 本文档描述通用任务调度模块的**需求**（职责、接口契约、配置项），不涉及具体实现细节。实现方案将在需求评审通过后另行出具设计文档。

## 1. 背景与动机

当前代码库在多处存在"并发执行一批异步任务 + 失败重试"的需求，典型场景是 `StreamingReviewOrchestrator` 并发调用多个 Claude Agent，并在遇到 API 限流（HTTP 429）时重试。现有实现散落在 `streaming-orchestrator.ts` 的多个方法中，存在以下问题：

- **重复代码**：并发控制与重试逻辑在非分段和分段审查路径各有一份
- **紧耦合**：重试策略硬编码，不易按场景调整
- **不可复用**：逻辑嵌在 orchestrator 方法内，其他项目/模块无法复用
- **不可单测**：无法在不启动真实 Agent 的情况下验证调度与重试行为

因此需要抽取一个通用、独立、可测试、零业务耦合的任务调度模块。

## 2. 目标

### 2.1 必须目标 (Must)

- **M1** 接收一组异步任务，按全局并发上限执行
- **M2** 对失败任务自动重试，区分"API 限流"与"其他瞬态错误"两类
- **M3** 遇到限流时优先遵循服务器 `Retry-After` 提示，否则使用指数退避
- **M4** 结果保持与输入顺序一致，区分成功/失败并给出尝试次数与耗时
- **M5** 纯模块，不依赖具体业务（Claude SDK、HTTP 客户端等），可在其他项目中复用
- **M6** 具备完整单元测试覆盖，使用 fake timers 验证退避时序

### 2.2 应该目标 (Should)

- **S1** 支持通过 `AbortSignal` 取消未启动的任务
- **S2** 允许调用方覆盖错误分类、重试判定逻辑（便于适配非 HTTP 场景）
- **S3** 支持单任务级别覆盖全局重试策略
- **S4** 通过事件回调提供可观测性，不强制打印日志

### 2.3 非目标 (Non-goals)

- 不实现任务优先级调度
- 不实现任务超时（由调用方通过 `AbortSignal` 自行控制）
- 不实现跨进程/分布式调度
- 不实现任务依赖图（DAG）

## 3. 主要职责

| 编号 | 职责             | 说明                                                                   |
| ---- | ---------------- | ---------------------------------------------------------------------- |
| R1   | **并发控制**     | 任意时刻执行中的任务数不超过 `concurrency` 上限                        |
| R2   | **错误分类**     | 区分"限流（429）"与"其他错误"两类，走不同重试策略                      |
| R3   | **限流重试**     | 解析服务器 `Retry-After`；若无，使用指数退避；受最大次数与单次上限约束 |
| R4   | **瞬态错误重试** | 按指数退避延迟重试，受最大次数与单次上限约束                           |
| R5   | **结果收集**     | 返回与输入顺序一致的结果数组，每项含成功/失败标志及元数据              |
| R6   | **取消支持**     | 响应 `AbortSignal`，不再启动新任务，将信号传递给正在执行的任务         |
| R7   | **事件通知**     | 通过回调告知任务生命周期变化，不依赖任何具体日志库                     |

## 4. 接口设计（契约层面）

> 仅描述**概念接口**与语义，字段名、类型细节在设计阶段可进一步微调。

### 4.1 Task 任务

一个任务代表一次待执行的异步操作。

| 字段          | 类型                   | 必填 | 说明                             |
| ------------- | ---------------------- | ---- | -------------------------------- |
| `id`          | string                 | 是   | 任务唯一标识，用于日志与结果对应 |
| `label`       | string                 | 否   | 人类可读名称（展示给用户）       |
| `run`         | `(ctx) => Promise<T>`  | 是   | 任务本体，可能被重复调用         |
| `retryPolicy` | Partial\<RetryPolicy\> | 否   | 覆盖全局重试策略的任务级配置     |

`run` 函数接收 `TaskContext`：

| 字段            | 说明                          |
| --------------- | ----------------------------- |
| `attempt`       | 当前尝试编号（从 1 开始）     |
| `totalAttempts` | 已失败次数（正常 + 限流合计） |
| `signal`        | 从调度器传入的 `AbortSignal`  |

### 4.2 TaskResult 结果

| 字段                | 类型     | 说明                                                                                                              |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                | string   | 对应的任务 id                                                                                                     |
| `label`             | string?  | 对应的任务 label                                                                                                  |
| `success`           | boolean  | 是否最终成功                                                                                                      |
| `value`             | T?       | 成功时的返回值                                                                                                    |
| `error`             | unknown? | 失败时最后一次抛出的错误                                                                                          |
| `attempts`          | number   | 总尝试次数                                                                                                        |
| `rateLimitAttempts` | number   | 其中归类为限流的失败次数                                                                                          |
| `elapsedMs`         | number   | 从第一次启动到最终完成的总耗时（含等待与重试）                                                                    |
| `lastRunMs`         | number   | 最后一次 `run()` 调用的耗时。成功时为最终成功运行的耗时；失败时为最后一次失败运行的耗时。**不包含**等待退避的时间 |

### 4.3 Scheduler 入口

提供单一函数式 API：

```typescript
function runTasks<T>(tasks: Task<T>[], options: SchedulerOptions): Promise<TaskResult<T>[]>;
```

调用方在需要复用配置时，可自行封装并共享 `SchedulerOptions` 对象；模块本身不提供类实例或其他状态性 API，保持调用接口最小化。

### 4.4 SchedulerEvent 事件

`onEvent(event)` 会在以下节点被触发，用于调用方自定义日志/进度显示：

| type           | 触发时机                         | 附带字段                                                           |
| -------------- | -------------------------------- | ------------------------------------------------------------------ |
| `task-start`   | 每次调用 `run` 前                | `taskId, label, attempt`                                           |
| `task-retry`   | 决定重试、等待开始前             | `taskId, label, attempt, nextAttempt, error, delayMs, isRateLimit` |
| `task-success` | 任务最终成功                     | `taskId, label, attempts, elapsedMs, lastRunMs`                    |
| `task-failure` | 重试耗尽或不可重试，任务最终失败 | `taskId, label, attempts, error, elapsedMs, lastRunMs`             |

### 4.5 失败语义

`runTasks` **不抛异常**（被 `AbortSignal` 取消除外），无论任务成功失败都通过 `TaskResult.success` 区分。**是否将失败汇总为异常由调用方决定**。这与 `Promise.allSettled` 的哲学一致。

## 5. 配置项定义

### 5.1 SchedulerOptions 调度器选项

| 字段          | 类型                         | 默认值         | 说明                            |
| ------------- | ---------------------------- | -------------- | ------------------------------- |
| `concurrency` | number                       | 无（必填）     | 全局并发上限，必须为 ≥ 1 的整数 |
| `retryPolicy` | Partial\<RetryPolicy\>       | 全部使用默认值 | 重试策略覆盖                    |
| `signal`      | AbortSignal?                 | 无             | 取消信号，触发后不再启动新任务  |
| `onEvent`     | (e: SchedulerEvent) => void? | 无             | 事件回调                        |

### 5.2 RetryPolicy 重试策略

| 字段                   | 类型           | 默认值                         | 说明                                            |
| ---------------------- | -------------- | ------------------------------ | ----------------------------------------------- |
| `maxRetries`           | number         | 2                              | 瞬态错误最大重试次数（不含首次）                |
| `retryBaseDelayMs`     | number         | 2000                           | 瞬态错误基础延迟，实际 `delay = base * 2^(n-1)` |
| `retryMaxDelayMs`      | number         | 60000                          | 瞬态错误单次等待硬上限（默认 60 秒）            |
| `maxRateLimitRetries`  | number         | 5                              | 限流错误最大重试次数                            |
| `rateLimitBaseDelayMs` | number         | 30000                          | 限流基础延迟，实际 `delay = base * 2^(n-1)`     |
| `rateLimitMaxDelayMs`  | number         | 600000                         | 限流单次等待硬上限（默认 10 分钟）              |
| `isRateLimitError`     | (e) => boolean | 内置默认实现                   | 识别是否为限流错误                              |
| `extractRetryAfterMs`  | (e) => number? | 内置默认实现                   | 从错误中解析 Retry-After                        |
| `isRetryableError`     | (e) => boolean | 默认认为全部非限流错误均可重试 | 非限流错误是否可重试                            |

### 5.3 默认错误分类规则

**isRateLimitError**（默认）任一满足即判定为限流：

1. `error.status === 429` 或 `error.statusCode === 429`
2. `error.code === 429` 或 `error.code === '429'`

> 仅通过错误码识别；若调用方使用的 SDK 抛出的错误没有标准状态码字段，可通过 `RetryPolicy.isRateLimitError` 传入自定义判定逻辑。

**extractRetryAfterMs**（默认）：

- 从 `error.headers['retry-after']` 或 `error.response.headers['retry-after']` 取值
- 支持纯数字（秒）与 HTTP-date（RFC 7231）两种格式
- 解析失败返回 `undefined`

### 5.4 延迟计算规则

**瞬态错误**（指数退避）：

```
delay = min(retryBaseDelayMs * 2^(瞬态失败次数 - 1), retryMaxDelayMs)
默认序列 (maxRetries=2): 2s → 4s
若上调 maxRetries=5: 2s → 4s → 8s → 16s → 32s（受 60s 上限约束）
```

**限流错误**（指数退避，Retry-After 覆盖基础延迟）：

```
base = extractRetryAfterMs(error) ?? rateLimitBaseDelayMs
delay = min(base * 2^(限流失败次数 - 1), rateLimitMaxDelayMs)

服务器无 Retry-After 时，默认序列: 30s → 60s → 120s → 240s → 480s
服务器返回 Retry-After: 60 时，序列:   60s → 120s → 240s → 480s → 600s(上限)
```

> 设计意图：服务器比调用方更了解当前限流恢复节奏，若给出 Retry-After 则**将其作为指数退避的起点**；仍然保留指数放大，避免恢复后立刻再次触发限流。

## 6. 验收标准

模块实现后需通过以下验证：

### 6.1 功能验收

- [ ] 10 个任务、`concurrency=3`，任意时刻在执行的任务数 ≤ 3
- [ ] 结果顺序与输入顺序一致
- [ ] 瞬态错误：失败 N 次后按默认策略重试，第 3 次仍失败则返回 `success: false`
- [ ] 限流错误：自动改走长退避，重试 5 次后失败
- [ ] 服务器返回 `Retry-After: 60` 时，首次等待 60s，第二次 120s，第三次 240s（以 Retry-After 为指数退避起点）
- [ ] 服务器无 `Retry-After` 时，首次等待 `rateLimitBaseDelayMs` 值（默认 30s）
- [ ] `Retry-After` 计算结果超过 `rateLimitMaxDelayMs` 时，被上限截断
- [ ] 混合成功/失败：都能正确返回，不中断其他任务
- [ ] `AbortSignal` 触发：未启动任务返回 AbortError，正在运行任务收到 signal

### 6.2 事件验收

- [ ] 每个任务至少触发一次 `task-start`
- [ ] 每次重试触发一次 `task-retry`，字段完整
- [ ] 成功任务最终触发一次 `task-success`
- [ ] 失败任务最终触发一次 `task-failure`

### 6.3 非功能验收

- [ ] 模块内不包含 `console.*` 调用
- [ ] 模块内不引用项目内部模块（`src/review/*` 等）
- [ ] 单元测试全部通过，且使用 fake timers，单测套件执行时间 < 1s

## 7. 使用场景示例

### 7.1 现有 Orchestrator 集成

```typescript
// 非分段审查：一个 segment × 多个 agent
const tasks = agentsToRun.map((agentType) => ({
  id: agentType,
  label: agentType,
  run: () => this.runStreamingAgent(agentType, context, ...),
}));

const results = await runTasks(tasks, {
  concurrency: this.options.maxConcurrency ?? 2,
  onEvent: (e) => this.reportProgress(e),
  signal: this.options.abortController?.signal,
});
```

### 7.2 其他潜在场景

- 批量 HTTP 请求：结合 axios 错误对象自动识别 429
- 批量文件处理：自定义 `isRateLimitError` 总是返回 false，只保留瞬态重试
- 批量 LLM 调用：任意 LLM SDK 均可接入

## 8. 非功能需求

| 类型           | 要求                                          |
| -------------- | --------------------------------------------- |
| **依赖**       | 仅允许依赖 `p-limit`，不得引入项目内部模块    |
| **TypeScript** | 全部类型显式导出，保证下游使用有完整类型提示  |
| **测试**       | 使用 `vitest` + fake timers；覆盖率目标 ≥ 90% |
| **文档**       | 模块内每个公共 API 必须有 JSDoc 注释          |
| **代码风格**   | 遵循仓库现有 ESLint / Prettier 规则           |

## 9. 待确认事项

| #   | 问题                                                                 | 建议                                                                    |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Q1  | 模块放在 `src/task-scheduler/` 还是 `src/utils/task-scheduler/`？    | 独立目录 `src/task-scheduler/`，便于未来抽出独立包 ✓                    |
| Q2  | 模块命名：`task-scheduler`、`retry-runner`、`task-pool` 哪个更合适？ | `task-scheduler` ✓                                                      |
| Q3  | 是否需要同时提供 `runTasks` 函数与 `TaskScheduler` 类？              | **仅提供 `runTasks` 函数**，保持 API 最小化 ✓                           |
| Q4  | 是否默认把"超时错误"也归为瞬态错误可重试？                           | 是，由 `isRetryableError` 默认全放行；如需排除由调用方传入 ✓            |
| Q5  | `task-failure` 事件是否在最后一次尝试后、还是 retry 耗尽时触发？     | 在任务最终失败（返回 result 前）触发一次，不与最后一次 retry 事件重复 ✓ |

---

**请评审以上需求。确认无误后将据此产出设计文档（数据结构、流程、实现要点），随后按"先实现 + 单测 → 重构 orchestrator 接入"的顺序推进。**
