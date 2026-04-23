/**
 * Error Classifier Tests
 */

import { describe, it, expect } from 'vitest';
import {
  defaultErrorClassifier,
  rateLimitOnlyClassifier,
  errorClassifierInternals,
} from '../../src/task-scheduler/index.js';

const { isHttp429Error, extractRetryAfterMs, isRetryableError } = errorClassifierInternals;

describe('isHttp429Error', () => {
  it('should return false for null/undefined', () => {
    expect(isHttp429Error(null)).toBe(false);
    expect(isHttp429Error(undefined)).toBe(false);
  });

  it('should detect statusCode=429', () => {
    expect(isHttp429Error({ statusCode: 429 })).toBe(true);
    expect(isHttp429Error({ statusCode: 500 })).toBe(false);
    expect(isHttp429Error({ statusCode: 200 })).toBe(false);
  });

  it('should detect status=429', () => {
    expect(isHttp429Error({ status: 429 })).toBe(true);
    expect(isHttp429Error({ status: 500 })).toBe(false);
    expect(isHttp429Error({ status: 200 })).toBe(false);
  });

  it('should detect response.status=429', () => {
    expect(isHttp429Error({ response: { status: 429 } })).toBe(true);
    expect(isHttp429Error({ response: { status: 500 } })).toBe(false);
  });

  it('should detect response.statusCode=429', () => {
    expect(isHttp429Error({ response: { statusCode: 429 } })).toBe(true);
    expect(isHttp429Error({ response: { statusCode: 500 } })).toBe(false);
  });
});

describe('extractRetryAfterMs', () => {
  it('should return undefined for null/undefined', () => {
    expect(extractRetryAfterMs(null)).toBeUndefined();
    expect(extractRetryAfterMs(undefined)).toBeUndefined();
  });

  it('should extract numeric retry-after (converted from seconds to ms)', () => {
    const error = { response: { headers: { 'retry-after': '10' } } };
    expect(extractRetryAfterMs(error)).toBe(10000);
  });

  it('should extract numeric retry-after as number', () => {
    const error = { response: { headers: { 'retry-after': 10 } } };
    expect(extractRetryAfterMs(error)).toBe(10000);
  });

  it('should handle large numbers as milliseconds', () => {
    const error = { response: { headers: { 'retry-after': 5000 } } };
    expect(extractRetryAfterMs(error)).toBe(5000);
  });

  it('should extract Retry-After header (case insensitive)', () => {
    const error1 = { response: { headers: { 'Retry-After': '5' } } };
    expect(extractRetryAfterMs(error1)).toBe(5000);

    const error2 = { response: { headers: { 'RETRY-AFTER': '3' } } };
    expect(extractRetryAfterMs(error2)).toBe(3000);
  });

  it('should extract retryAfter from response object', () => {
    const error = { response: { retryAfter: '15' } };
    expect(extractRetryAfterMs(error)).toBe(15000);
  });

  it('should extract retryAfterMs directly', () => {
    const error = { retryAfterMs: 5000 };
    expect(extractRetryAfterMs(error)).toBe(5000);
  });

  it('should handle HTTP date format', () => {
    const future = new Date(Date.now() + 10000); // 10 seconds from now
    const error = { response: { headers: { 'retry-after': future.toUTCString() } } };
    // Allow larger time difference due to test execution time and async delays
    const result = extractRetryAfterMs(error);
    expect(result).toBeGreaterThanOrEqual(9000);
    expect(result).toBeLessThanOrEqual(11000);
  });

  it('should return undefined for past date', () => {
    const past = new Date(Date.now() - 10000);
    const error = { response: { headers: { 'retry-after': past.toUTCString() } } };
    expect(extractRetryAfterMs(error)).toBeUndefined();
  });

  it('should handle invalid values', () => {
    expect(
      extractRetryAfterMs({ response: { headers: { 'retry-after': 'invalid' } } })
    ).toBeUndefined();
    expect(extractRetryAfterMs({ response: { headers: { 'retry-after': '-1' } } })).toBeUndefined();
    expect(extractRetryAfterMs({ response: { headers: { 'retry-after': '0' } } })).toBeUndefined();
  });
});

describe('isRetryableError', () => {
  it('should return false for null/undefined', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('should detect rate limit (429) as retryable', () => {
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it('should detect 5xx server errors as retryable', () => {
    expect(isRetryableError({ statusCode: 500 })).toBe(true);
    expect(isRetryableError({ statusCode: 502 })).toBe(true);
    expect(isRetryableError({ statusCode: 503 })).toBe(true);
    expect(isRetryableError({ statusCode: 504 })).toBe(true);
    expect(isRetryableError({ statusCode: 599 })).toBe(true);
  });

  it('should not detect 4xx client errors as retryable', () => {
    expect(isRetryableError({ statusCode: 400 })).toBe(false);
    expect(isRetryableError({ statusCode: 401 })).toBe(false);
    expect(isRetryableError({ statusCode: 404 })).toBe(false);
  });

  it('should detect network error codes', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('should detect timeout messages', () => {
    expect(isRetryableError({ message: 'Request timeout' })).toBe(true);
    expect(isRetryableError({ message: 'Connection timed out' })).toBe(true);
  });
});

describe('defaultErrorClassifier', () => {
  it('should classify 429 as rate limit and retryable', () => {
    const result = defaultErrorClassifier({
      statusCode: 429,
      response: { headers: { 'retry-after': '5' } },
    });
    expect(result).toEqual({
      retryable: true,
      isRateLimit: true,
      retryAfterMs: 5000,
    });
  });

  it('should classify 500 as retryable but not rate limit', () => {
    const result = defaultErrorClassifier({ statusCode: 500 });
    expect(result).toEqual({
      retryable: true,
      isRateLimit: false,
      retryAfterMs: undefined,
    });
  });

  it('should classify 400 as not retryable', () => {
    const result = defaultErrorClassifier({ statusCode: 400 });
    expect(result).toEqual({
      retryable: false,
      isRateLimit: false,
      retryAfterMs: undefined,
    });
  });

  it('should classify network errors as retryable', () => {
    const result = defaultErrorClassifier({ code: 'ECONNRESET' });
    expect(result.retryable).toBe(true);
    expect(result.isRateLimit).toBe(false);
  });
});

describe('rateLimitOnlyClassifier', () => {
  it('should only mark 429 as retryable', () => {
    const result429 = rateLimitOnlyClassifier({ statusCode: 429 });
    expect(result429.retryable).toBe(true);
    expect(result429.isRateLimit).toBe(true);

    const result500 = rateLimitOnlyClassifier({ statusCode: 500 });
    expect(result500.retryable).toBe(false);
    expect(result500.isRateLimit).toBe(false);

    const resultNetwork = rateLimitOnlyClassifier({ code: 'ECONNRESET' });
    expect(resultNetwork.retryable).toBe(false);
    expect(resultNetwork.isRateLimit).toBe(false);
  });
});
