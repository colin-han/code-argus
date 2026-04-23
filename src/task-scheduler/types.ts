/**
 * Task Scheduler - Type Definitions
 *
 * 任务调度模块的核心类型定义
 */

/**
 * 任务函数类型
 * T - 任务返回值类型
 */
export type Task<T = unknown> = (context: TaskContext) => Promise<T>;

/**
 * 任务执行上下文
 * 每个任务执行时接收的上下文对象
 */
export interface TaskContext {
  /** 任务在原始数组中的索引 */
  index: number;
  /** 本次执行的尝试次数（从1开始） */
  attempt: number;
  /** 用于取消任务的 AbortSignal */
  signal: AbortSignal;
  /** 任务元数据（用户自定义） */
  meta?: Record<string, unknown>;
}

/**
 * 任务执行结果
 * T - 任务返回值类型
 */
export interface TaskResult<T = unknown> {
  /** 任务在原始数组中的索引 */
  index: number;
  /** 是否成功 */
  success: boolean;
  /** 任务返回值（仅成功时） */
  value?: T;
  /** 失败原因（仅失败时） */
  error?: Error;
  /** 总尝试次数（包含失败和成功） */
  attempts: number;
  /** 从开始到最终完成的总耗时（毫秒） */
  elapsedMs: number;
  /** 最后一次运行的耗时（毫秒） */
  lastRunMs: number;
}

/**
 * 错误分类结果
 */
export interface ErrorClassification {
  /** 是否可重试 */
  retryable: boolean;
  /** 是否为限流错误 */
  isRateLimit: boolean;
  /** 服务器建议的等待时间（毫秒，限流时可能有） */
  retryAfterMs?: number;
}

/**
 * 错误分类器函数类型
 */
export type ErrorClassifier = (error: unknown) => ErrorClassification;

/**
 * 重试策略配置
 */
export interface RetryPolicy {
  /** 最大重试次数（不包含首次尝试） */
  maxRetries: number;
  /** 初始延迟（毫秒） */
  baseDelayMs: number;
  /** 最大延迟（毫秒，指数退避上限） */
  maxDelayMs: number;
  /** 延迟乘数（指数退避基数） */
  backoffMultiplier: number;
}

/**
 * 限流专用重试策略配置
 */
export interface RateLimitRetryPolicy extends RetryPolicy {
  /** 是否优先使用服务器的 Retry-After 头 */
  respectRetryAfter: boolean;
}

/**
 * 完整重试策略配置（区分普通错误和限流错误） */
export interface RetryConfig {
  /** 普通瞬态错误的重试策略 */
  transient: RetryPolicy;
  /** 限流错误的重试策略 */
  rateLimit: RateLimitRetryPolicy;
}

/**
 * 调度器事件类型
 */
export type SchedulerEventType =
  | 'task-start'
  | 'task-success'
  | 'task-error'
  | 'task-retry'
  | 'task-cancel';

/**
 * 调度器事件对象
 */
export interface SchedulerEvent {
  /** 事件类型 */
  type: SchedulerEventType;
  /** 任务索引 */
  index: number;
  /** 当前尝试次数 */
  attempt: number;
  /** 错误对象（error 和 retry 事件） */
  error?: Error;
  /** 是否可重试（error 事件） */
  retryable?: boolean;
  /** 下次重试延迟（retry 事件） */
  retryDelayMs?: number;
  /** 任务返回值（success 事件） */
  value?: unknown;
  /** 本次执行耗时（success 和 error 事件） */
  elapsedMs?: number;
}

/**
 * 调度器事件回调
 */
export type SchedulerEventCallback = (event: SchedulerEvent) => void | Promise<void>;

/**
 * 任务调度器选项
 */
export interface SchedulerOptions {
  /** 最大并发数（默认：5） */
  concurrency?: number;
  /** 重试策略配置 */
  retry?: Partial<RetryConfig>;
  /** 错误分类器（默认使用内置实现） */
  errorClassifier?: ErrorClassifier;
  /** 事件回调 */
  onEvent?: SchedulerEventCallback;
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * 运行任务函数类型
 */
export type RunTasksFunction = <T>(
  tasks: Task<T>[],
  options?: SchedulerOptions
) => Promise<TaskResult<T>[]>;
