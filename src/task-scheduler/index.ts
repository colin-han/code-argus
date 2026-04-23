/**
 * Task Scheduler
 *
 * 通用任务调度模块
 * - 并发控制
 * - 重试机制（指数退避 + 限流特殊处理）
 * - 事件通知
 * - 取消支持
 */

// 类型导出
export type {
  Task,
  TaskContext,
  TaskResult,
  ErrorClassification,
  ErrorClassifier,
  RetryPolicy,
  RateLimitRetryPolicy,
  RetryConfig,
  SchedulerEvent,
  SchedulerEventType,
  SchedulerEventCallback,
  SchedulerOptions,
  RunTasksFunction,
} from './types.js';

// 错误分类器导出
export {
  defaultErrorClassifier,
  rateLimitOnlyClassifier,
  _internals as errorClassifierInternals,
} from './error-classifier.js';

// 重试策略导出
export type { PartialRetryConfig } from './retry-policy.js';
export {
  DEFAULT_TRANSIENT_POLICY,
  DEFAULT_RATE_LIMIT_POLICY,
  normalizeRetryConfig,
  calculateRetryDelay,
  calculateRetryDelayWithJitter,
  createFixedDelayPolicy,
  createNoRetryPolicy,
  createRateLimitOnlyPolicy,
} from './retry-policy.js';

// 核心函数导出
export { runTasks } from './run-tasks.js';
