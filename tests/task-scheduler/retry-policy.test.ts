/**
 * Retry Policy Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeRetryConfig,
  calculateRetryDelay,
  calculateRetryDelayWithJitter,
  createFixedDelayPolicy,
  createNoRetryPolicy,
  createRateLimitOnlyPolicy,
  DEFAULT_TRANSIENT_POLICY,
  DEFAULT_RATE_LIMIT_POLICY,
} from '../../src/task-scheduler/index.js';

describe('normalizeRetryConfig', () => {
  it('should return default config when no overrides provided', () => {
    const config = normalizeRetryConfig();
    expect(config.transient).toEqual(DEFAULT_TRANSIENT_POLICY);
    expect(config.rateLimit).toEqual(DEFAULT_RATE_LIMIT_POLICY);
  });

  it('should merge transient overrides', () => {
    const config = normalizeRetryConfig({
      transient: { maxRetries: 5 },
    });
    expect(config.transient.maxRetries).toBe(5);
    expect(config.transient.baseDelayMs).toBe(DEFAULT_TRANSIENT_POLICY.baseDelayMs);
    expect(config.rateLimit).toEqual(DEFAULT_RATE_LIMIT_POLICY);
  });

  it('should merge rateLimit overrides', () => {
    const config = normalizeRetryConfig({
      rateLimit: { maxRetries: 10 },
    });
    expect(config.rateLimit.maxRetries).toBe(10);
    expect(config.rateLimit.baseDelayMs).toBe(DEFAULT_RATE_LIMIT_POLICY.baseDelayMs);
    expect(config.transient).toEqual(DEFAULT_TRANSIENT_POLICY);
  });

  it('should merge both transient and rateLimit overrides', () => {
    const config = normalizeRetryConfig({
      transient: { maxRetries: 2, baseDelayMs: 500 },
      rateLimit: { maxRetries: 8, respectRetryAfter: false },
    });
    expect(config.transient.maxRetries).toBe(2);
    expect(config.transient.baseDelayMs).toBe(500);
    expect(config.rateLimit.maxRetries).toBe(8);
    expect(config.rateLimit.respectRetryAfter).toBe(false);
  });
});

describe('calculateRetryDelay', () => {
  it('should calculate exponential backoff', () => {
    const policy = {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
      maxRetries: 5,
    };

    // attempt 1: 1000 * 2^0 = 1000
    expect(calculateRetryDelay({ attempt: 1, policy })).toBe(1000);
    // attempt 2: 1000 * 2^1 = 2000
    expect(calculateRetryDelay({ attempt: 2, policy })).toBe(2000);
    // attempt 3: 1000 * 2^2 = 4000
    expect(calculateRetryDelay({ attempt: 3, policy })).toBe(4000);
    // attempt 4: 1000 * 2^3 = 8000
    expect(calculateRetryDelay({ attempt: 4, policy })).toBe(8000);
    // attempt 5: 1000 * 2^4 = 16000 -> capped at 10000
    expect(calculateRetryDelay({ attempt: 5, policy })).toBe(10000);
  });

  it('should apply maxDelayMs cap', () => {
    const policy = {
      baseDelayMs: 5000,
      maxDelayMs: 6000,
      backoffMultiplier: 2,
      maxRetries: 5,
    };

    expect(calculateRetryDelay({ attempt: 1, policy })).toBe(5000);
    // attempt 2: 5000 * 2 = 10000 -> capped at 6000
    expect(calculateRetryDelay({ attempt: 2, policy })).toBe(6000);
  });

  it('should use retryAfterMs for rate limit when larger than base delay', () => {
    const policy = {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      maxRetries: 5,
      respectRetryAfter: true,
    };

    // retryAfterMs > baseDelayMs, so baseDelay becomes 5000
    const delay1 = calculateRetryDelay({
      attempt: 1,
      policy,
      retryAfterMs: 5000,
    });
    expect(delay1).toBe(5000); // 5000 * 2^0 = 5000

    // attempt 2 with same retryAfter
    const delay2 = calculateRetryDelay({
      attempt: 2,
      policy,
      retryAfterMs: 5000,
    });
    expect(delay2).toBe(10000); // 5000 * 2^1 = 10000
  });

  it('should not use retryAfterMs when smaller than base delay', () => {
    const policy = {
      baseDelayMs: 5000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      maxRetries: 5,
      respectRetryAfter: true,
    };

    // retryAfterMs < baseDelayMs, so baseDelay stays 5000
    const delay = calculateRetryDelay({
      attempt: 1,
      policy,
      retryAfterMs: 1000,
    });
    expect(delay).toBe(5000); // 5000 * 2^0 = 5000 (not 1000)
  });

  it('should ignore retryAfterMs when respectRetryAfter is false', () => {
    const policy = {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      maxRetries: 5,
      respectRetryAfter: false,
    };

    const delay = calculateRetryDelay({
      attempt: 1,
      policy,
      retryAfterMs: 5000, // should be ignored
    });
    expect(delay).toBe(1000); // uses baseDelayMs
  });
});

describe('calculateRetryDelayWithJitter', () => {
  it('should add jitter around base delay', () => {
    const policy = {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
      maxRetries: 5,
    };

    // With 10% jitter, delay should be between 900 and 1100
    for (let i = 0; i < 100; i++) {
      const delay = calculateRetryDelayWithJitter({
        attempt: 1,
        policy,
        jitterRatio: 0.1,
      });
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1100);
    }
  });

  it('should use default jitter ratio of 0.1', () => {
    const policy = {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
      maxRetries: 5,
    };

    // Mock Math.random to return 0 (minimum jitter)
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delayMin = calculateRetryDelayWithJitter({
      attempt: 1,
      policy,
    });
    expect(delayMin).toBe(900); // 1000 * 0.9

    // Mock Math.random to return 1 (maximum jitter)
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const delayMax = calculateRetryDelayWithJitter({
      attempt: 1,
      policy,
    });
    expect(delayMax).toBe(1100); // 1000 * 1.1

    vi.restoreAllMocks();
  });
});

describe('createFixedDelayPolicy', () => {
  it('should create policy with fixed delay', () => {
    const policy = createFixedDelayPolicy(3000, 5);
    expect(policy.baseDelayMs).toBe(3000);
    expect(policy.maxDelayMs).toBe(3000);
    expect(policy.maxRetries).toBe(5);
    expect(policy.backoffMultiplier).toBe(1); // multiplier 1 means fixed delay

    // All attempts should return the same delay
    for (let i = 1; i <= 5; i++) {
      expect(calculateRetryDelay({ attempt: i, policy })).toBe(3000);
    }
  });
});

describe('createNoRetryPolicy', () => {
  it('should create policy with no retries', () => {
    const policy = createNoRetryPolicy();
    expect(policy.maxRetries).toBe(0);
    expect(policy.baseDelayMs).toBe(0);
    expect(policy.maxDelayMs).toBe(0);
  });
});

describe('createRateLimitOnlyPolicy', () => {
  it('should create policy with defaults', () => {
    const policy = createRateLimitOnlyPolicy();
    expect(policy.maxRetries).toBe(DEFAULT_RATE_LIMIT_POLICY.maxRetries);
    expect(policy.baseDelayMs).toBe(DEFAULT_RATE_LIMIT_POLICY.baseDelayMs);
    expect(policy.maxDelayMs).toBe(DEFAULT_RATE_LIMIT_POLICY.maxDelayMs);
    expect(policy.respectRetryAfter).toBe(true);
  });

  it('should allow overrides', () => {
    const policy = createRateLimitOnlyPolicy({
      maxRetries: 3,
      respectRetryAfter: false,
    });
    expect(policy.maxRetries).toBe(3);
    expect(policy.respectRetryAfter).toBe(false);
    // Other properties should be defaults
    expect(policy.baseDelayMs).toBe(DEFAULT_RATE_LIMIT_POLICY.baseDelayMs);
  });
});
