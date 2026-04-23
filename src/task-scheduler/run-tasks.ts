/**
 * Task Scheduler - Run Tasks
 *
 * 核心任务执行逻辑：并发控制、重试、事件、取消
 */

import pLimit from 'p-limit';
import type {
  Task,
  TaskContext,
  TaskResult,
  SchedulerOptions,
  SchedulerEvent,
  SchedulerEventCallback,
  ErrorClassification,
  RetryConfig,
} from './types.js';
import { defaultErrorClassifier } from './error-classifier.js';
import { normalizeRetryConfig, calculateRetryDelay } from './retry-policy.js';

/**
 * 延迟函数（支持 AbortSignal）
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Task cancelled'));
      return;
    }

    let onAbort: (() => void) | undefined;
    let cleanup: (() => void) | undefined;

    const timer = setTimeout(() => {
      cleanup?.();
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        cleanup?.();
        reject(new Error('Task cancelled'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      cleanup = () => {
        clearTimeout(timer);
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      };
    }
  });
}

/**
 * 执行单个任务（包含重试逻辑）
 */
async function executeTaskWithRetry<T>(params: {
  task: Task<T>;
  index: number;
  errorClassifier: (error: unknown) => ErrorClassification;
  retryConfig: RetryConfig;
  onEvent?: SchedulerEventCallback;
  signal?: AbortSignal;
}): Promise<TaskResult<T>> {
  const { task, index, errorClassifier, retryConfig, onEvent, signal } = params;
  const startTime = Date.now();
  let lastRunStart: number;
  let attempts = 0;

  // 初始的 AbortSignal
  let currentSignal = signal;

  while (true) {
    attempts++;
    lastRunStart = Date.now();

    // 检查取消
    if (currentSignal?.aborted) {
      throw new Error('Task cancelled');
    }

    // 发送任务开始事件
    await emitEvent(onEvent, {
      type: 'task-start',
      index,
      attempt: attempts,
    });

    try {
      // 创建任务上下文
      const context: TaskContext = {
        index,
        attempt: attempts,
        signal: currentSignal ?? new AbortController().signal,
      };

      // 执行任务
      const value = await task(context);
      const lastRunMs = Date.now() - lastRunStart;
      const elapsedMs = Date.now() - startTime;

      // 发送成功事件
      await emitEvent(onEvent, {
        type: 'task-success',
        index,
        attempt: attempts,
        value,
        elapsedMs: lastRunMs,
      });

      return {
        index,
        success: true,
        value,
        attempts,
        elapsedMs,
        lastRunMs,
      };
    } catch (error) {
      const lastRunMs = Date.now() - lastRunStart;
      const elapsedMs = Date.now() - startTime;

      // 分类错误
      const classification = errorClassifier(error);

      // 发送错误事件
      await emitEvent(onEvent, {
        type: 'task-error',
        index,
        attempt: attempts,
        error: error instanceof Error ? error : new Error(String(error)),
        retryable: classification.retryable,
      });

      // 判断是否需要重试
      const policy = classification.isRateLimit ? retryConfig.rateLimit : retryConfig.transient;

      const maxAttempts = policy.maxRetries + 1; // +1 for initial attempt

      // 不可重试或已达到最大重试次数
      if (!classification.retryable || attempts >= maxAttempts) {
        return {
          index,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
          attempts,
          elapsedMs,
          lastRunMs,
        };
      }

      // 计算重试延迟
      const retryAfterMs = classification.isRateLimit ? classification.retryAfterMs : undefined;

      const delayMs = calculateRetryDelay({
        attempt: attempts,
        policy,
        retryAfterMs,
      });

      // 发送重试事件
      await emitEvent(onEvent, {
        type: 'task-retry',
        index,
        attempt: attempts,
        retryDelayMs: delayMs,
      });

      // 等待重试延迟（支持取消）
      try {
        await delay(delayMs, signal);
      } catch (delayError) {
        // 延迟期间被取消
        throw new Error('Task cancelled', { cause: delayError });
      }
    }
  }
}

/**
 * 发送事件（支持异步回调）
 */
async function emitEvent(
  callback: SchedulerEventCallback | undefined,
  event: SchedulerEvent
): Promise<void> {
  if (!callback) return;

  try {
    await callback(event);
  } catch {
    // 事件回调错误不应影响任务执行
  }
}

/**
 * 执行任务数组
 *
 * 核心功能：
 * - 并发控制
 * - 重试逻辑
 * - 事件回调
 * - 取消支持
 * - 保持结果顺序
 */
export async function runTasks<T>(
  tasks: Task<T>[],
  options?: SchedulerOptions
): Promise<TaskResult<T>[]> {
  const {
    concurrency = 5,
    retry,
    errorClassifier = defaultErrorClassifier,
    onEvent,
    signal,
  } = options ?? {};

  // 归一化重试配置
  const retryConfig = normalizeRetryConfig(retry);

  // 空任务数组直接返回
  if (tasks.length === 0) {
    return [];
  }

  // 检查是否已取消
  if (signal?.aborted) {
    throw new Error('Task scheduler cancelled');
    // 注意：这里抛出异常而不是返回部分结果，因为还没开始执行
  }

  // 创建并发限制器
  const limit = pLimit(concurrency);

  // 创建任务包装器
  const wrappedTasks = tasks.map((task, index) =>
    limit(async () => {
      try {
        return await executeTaskWithRetry({
          task,
          index,
          errorClassifier,
          retryConfig,
          onEvent,
          signal,
        });
      } catch (error) {
        // 处理取消异常
        if (error instanceof Error && error.message === 'Task cancelled') {
          // 发送取消事件
          await emitEvent(onEvent, {
            type: 'task-cancel',
            index,
            attempt: 0,
          });

          // 返回取消结果
          return {
            index,
            success: false,
            error: new Error('Task cancelled'),
            attempts: 0,
            elapsedMs: 0,
            lastRunMs: 0,
          } as TaskResult<T>;
        }

        // 其他异常不应该发生，但保险起见处理一下
        throw error;
      }
    })
  );

  // 等待所有任务完成
  const results = await Promise.all(wrappedTasks);

  // 按原始索引排序（保持输入顺序）
  results.sort((a, b) => a.index - b.index);

  return results;
}
