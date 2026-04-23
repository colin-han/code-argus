/**
 * Task Scheduler - Error Classifier
 *
 * 错误分类和限流检测
 */

import type { ErrorClassification, ErrorClassifier } from './types.js';

/**
 * 检测错误是否为 HTTP 429 限流错误
 * 仅基于状态码判断，不使用错误消息关键词匹配
 */
function isHttp429Error(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  // 检查是否有 statusCode 或 status 属性
  const err = error as Record<string, unknown>;

  // 检查 statusCode
  if (typeof err.statusCode === 'number') {
    return err.statusCode === 429;
  }

  // 检查 status
  if (typeof err.status === 'number') {
    return err.status === 429;
  }

  // 检查 HTTPError 类型（很多 HTTP 客户端使用）
  if (err.response && typeof err.response === 'object') {
    const response = err.response as Record<string, unknown>;
    if (typeof response.status === 'number') {
      return response.status === 429;
    }
    if (typeof response.statusCode === 'number') {
      return response.statusCode === 429;
    }
  }

  return false;
}

/**
 * 从错误中提取 Retry-After 值（毫秒）
 * 支持多种格式：秒数字符串、日期字符串、数字
 */
function extractRetryAfterMs(error: unknown): number | undefined {
  if (error === null || error === undefined) return undefined;

  const err = error as Record<string, unknown>;

  // 查找 Retry-After 头
  let retryAfter: unknown;

  // 常见位置1: response.headers['retry-after']
  if (err.response && typeof err.response === 'object') {
    const response = err.response as Record<string, unknown>;

    // 检查 headers
    if (response.headers && typeof response.headers === 'object') {
      const headers = response.headers as Record<string, unknown>;

      // 尝试各种可能的 header 名称
      retryAfter =
        headers['retry-after'] ??
        headers['Retry-After'] ??
        headers['RETRY-AFTER'] ??
        headers['retryAfter'];
    }

    // 有些客户端直接把 retryAfter 放在 response 上
    if (retryAfter === undefined && response.retryAfter !== undefined) {
      retryAfter = response.retryAfter;
    }
  }

  // 常见位置2: 错误对象上的 retryAfter 属性
  if (retryAfter === undefined && err.retryAfter !== undefined) {
    retryAfter = err.retryAfter;
  }

  // 常见位置3: 错误对象上的 retryAfterMs 属性（已经是毫秒）
  if (retryAfter === undefined && err.retryAfterMs !== undefined) {
    const ms = Number(err.retryAfterMs);
    if (!isNaN(ms) && ms > 0) return Math.ceil(ms);
  }

  if (retryAfter === undefined) return undefined;

  // 解析值
  // 1. 数字（秒）
  if (typeof retryAfter === 'number') {
    if (retryAfter > 0) {
      // 大于 100 的通常已经是毫秒
      return retryAfter > 100 ? Math.ceil(retryAfter) : Math.ceil(retryAfter * 1000);
    }
    return undefined;
  }

  // 2. 字符串（秒数或 HTTP 日期）
  if (typeof retryAfter === 'string') {
    const trimmed = retryAfter.trim();

    // 尝试解析为数字（秒）
    const seconds = parseFloat(trimmed);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }

    // 尝试解析为 HTTP 日期（如 "Wed, 21 Oct 2015 07:28:00 GMT"）
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      const delayMs = date.getTime() - Date.now();
      return delayMs > 0 ? Math.ceil(delayMs) : undefined;
    }
  }

  return undefined;
}

/**
 * 检测错误是否可重试
 * 默认策略：网络错误、超时、5xx 服务器错误、限流错误都可重试
 */
function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const err = error as Record<string, unknown>;

  // 限流错误总是可重试
  if (isHttp429Error(error)) return true;

  // 网络错误检测
  const message = String(err.message ?? '');
  const code = String(err.code ?? '');

  // 常见可重试错误代码
  const retryableCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    'EPIPE',
    'ERR_NETWORK',
    'TIMEOUT',
    'REQUEST_TIMEOUT',
    'ABORTED',
  ];

  if (retryableCodes.some((c) => code === c || message.includes(c))) {
    return true;
  }

  // HTTP 5xx 服务器错误
  const statusCode =
    typeof err.statusCode === 'number'
      ? err.statusCode
      : typeof err.status === 'number'
        ? err.status
        : undefined;

  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return true;
  }

  // 特定错误消息
  const retryableMessages = [
    'timeout',
    'timed out',
    'network error',
    'connection reset',
    'connection refused',
    'socket hang up',
    'temporarily unavailable',
    'too many requests',
    'rate limit',
    'overloaded',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
  ];

  if (retryableMessages.some((m) => message.toLowerCase().includes(m))) {
    return true;
  }

  return false;
}

/**
 * 默认错误分类器
 * 用于区分限流错误和普通瞬态错误
 */
export const defaultErrorClassifier: ErrorClassifier = (error: unknown): ErrorClassification => {
  const isRateLimit = isHttp429Error(error);
  const retryable = isRetryableError(error);
  const retryAfterMs = isRateLimit ? extractRetryAfterMs(error) : undefined;

  return {
    retryable,
    isRateLimit,
    retryAfterMs,
  };
};

/**
 * 限流专用错误分类器
 * 只检测限流错误，其他错误都视为不可重试
 */
export const rateLimitOnlyClassifier: ErrorClassifier = (error: unknown): ErrorClassification => {
  const isRateLimit = isHttp429Error(error);

  return {
    retryable: isRateLimit,
    isRateLimit,
    retryAfterMs: isRateLimit ? extractRetryAfterMs(error) : undefined,
  };
};

// 导出内部函数用于测试
export const _internals = {
  isHttp429Error,
  extractRetryAfterMs,
  isRetryableError,
};
