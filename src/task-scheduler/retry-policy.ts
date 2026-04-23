/**
 * Task Scheduler - Retry Policy
 *
 * 重试策略归一化和延迟计算
 */

import type { RetryConfig, RetryPolicy, RateLimitRetryPolicy } from './types.js';

/**
 * 默认普通错误重试策略
 */
export const DEFAULT_TRANSIENT_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * 默认限流错误重试策略
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitRetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 2000,
  maxDelayMs: 120000,
  backoffMultiplier: 2,
  respectRetryAfter: true,
};

/**
 * 部分重试策略配置（用于用户覆盖）
 */
export type PartialRetryConfig = {
  transient?: Partial<RetryPolicy>;
  rateLimit?: Partial<RateLimitRetryPolicy>;
};

/**
 * 归一化重试策略配置
 * 将用户提供的部分配置与默认配置合并
 */
export function normalizeRetryConfig(partial?: PartialRetryConfig): RetryConfig {
  return {
    transient: {
      ...DEFAULT_TRANSIENT_POLICY,
      ...partial?.transient,
    },
    rateLimit: {
      ...DEFAULT_RATE_LIMIT_POLICY,
      ...partial?.rateLimit,
    },
  };
}

/**
 * 计算下次重试延迟
 *
 * 指数退避公式：delay = min(baseDelay * multiplier^(attempt-1), maxDelay)
 *
 * 对于限流错误：
 * - 如果服务器提供了 Retry-After 且 respectRetryAfter 为 true
 * - 则 baseDelay = max(baseDelay, retryAfterMs)
 * - 然后应用指数退避
 */
export function calculateRetryDelay(params: {
  attempt: number;
  policy: RetryPolicy | RateLimitRetryPolicy;
  retryAfterMs?: number;
}): number {
  const { attempt, policy, retryAfterMs } = params;

  // 确定基础延迟
  let baseDelay = policy.baseDelayMs;

  // 如果是限流策略且服务器提供了 Retry-After
  const rateLimitPolicy = policy as RateLimitRetryPolicy;
  if (
    retryAfterMs !== undefined &&
    rateLimitPolicy.respectRetryAfter !== false &&
    retryAfterMs > baseDelay
  ) {
    baseDelay = retryAfterMs;
  }

  // 指数退避计算
  // attempt 从 1 开始，所以指数是 attempt - 1
  const delay = baseDelay * Math.pow(policy.backoffMultiplier, attempt - 1);

  // 应用上限
  return Math.min(delay, policy.maxDelayMs);
}

/**
 * 带抖动的延迟计算
 * 添加随机抖动避免惊群效应
 */
export function calculateRetryDelayWithJitter(params: {
  attempt: number;
  policy: RetryPolicy | RateLimitRetryPolicy;
  retryAfterMs?: number;
  /** 抖动比例（0-1），默认 0.1 即 10% */
  jitterRatio?: number;
}): number {
  const delay = calculateRetryDelay(params);
  const jitterRatio = params.jitterRatio ?? 0.1;

  // 添加 ±jitterRatio 的随机抖动
  const jitter = delay * jitterRatio * (Math.random() * 2 - 1);

  return Math.max(0, Math.ceil(delay + jitter));
}

/**
 * 创建固定延迟策略（用于测试）
 */
export function createFixedDelayPolicy(delayMs: number, maxRetries = 3): RetryPolicy {
  return {
    maxRetries,
    baseDelayMs: delayMs,
    maxDelayMs: delayMs,
    backoffMultiplier: 1,
  };
}

/**
 * 创建无重试策略（用于测试或禁用重试场景）
 */
export function createNoRetryPolicy(): RetryPolicy {
  return {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplier: 1,
  };
}

/**
 * 创建仅限流重试策略
 * 普通错误不重试，只有限流错误才重试
 */
export function createRateLimitOnlyPolicy(
  overrides?: Partial<RateLimitRetryPolicy>
): RateLimitRetryPolicy {
  return {
    ...DEFAULT_RATE_LIMIT_POLICY,
    ...overrides,
  };
}
