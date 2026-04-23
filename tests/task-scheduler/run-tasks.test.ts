/**
 * Run Tasks Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTasks, type Task, type SchedulerEvent } from '../../src/task-scheduler/index.js';

describe('runTasks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic execution', () => {
    it('should execute single task successfully', async () => {
      const task: Task<number> = async () => 42;
      const results = await runTasks([task]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        index: 0,
        success: true,
        value: 42,
        attempts: 1,
      });
    });

    it('should execute multiple tasks and maintain order', async () => {
      const tasks: Task<number>[] = [async () => 1, async () => 2, async () => 3];
      const results = await runTasks(tasks);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
      expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    });

    it('should handle empty task array', async () => {
      const results = await runTasks([]);
      expect(results).toEqual([]);
    });

    it('should return success=false for failed tasks', async () => {
      const error = new Error('Task failed');
      const tasks: Task<void>[] = [
        async () => {
          throw error;
        },
      ];
      const results = await runTasks(tasks);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe(error);
      expect(results[0].attempts).toBe(1);
    });
  });

  describe('concurrency control', () => {
    it('should respect concurrency limit', async () => {
      let running = 0;
      let maxRunning = 0;

      const createTask =
        (delay: number): Task<void> =>
        async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((resolve) => setTimeout(resolve, delay));
          running--;
        };

      const tasks = Array(5)
        .fill(null)
        .map(() => createTask(50));
      const promise = runTasks(tasks, { concurrency: 2 });
      await vi.advanceTimersByTimeAsync(100);
      const results = await promise;

      expect(maxRunning).toBeLessThanOrEqual(2);
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should default to concurrency of 5', async () => {
      let running = 0;
      let maxRunning = 0;

      const createTask = (): Task<void> => async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running--;
      };

      const tasks = Array(10).fill(null).map(createTask);
      await runTasks(tasks);

      expect(maxRunning).toBeLessThanOrEqual(5);
    });
  });

  describe('retry logic', () => {
    it('should retry transient errors up to maxRetries', async () => {
      let attempts = 0;
      const tasks: Task<void>[] = [
        async () => {
          attempts++;
          if (attempts < 3) {
            const error = new Error('Transient error');
            (error as unknown as { code: string }).code = 'ECONNRESET';
            throw error;
          }
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          transient: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10000, backoffMultiplier: 2 },
        },
      });

      // Advance through retries
      await vi.advanceTimersByTimeAsync(300);
      const results = await promise;

      expect(results[0].success).toBe(true);
      expect(results[0].attempts).toBe(3);
    });

    it('should eventually fail after maxRetries exceeded', async () => {
      const tasks: Task<void>[] = [
        async () => {
          const error = new Error('Persistent error');
          (error as unknown as { code: string }).code = 'ECONNRESET';
          throw error;
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          transient: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 10000, backoffMultiplier: 2 },
        },
      });

      // Advance through all retries: initial (immediate fail) + 2 retries with delays
      // Delay formula: 10 * 2^(attempt-1), attempt=1: 10ms, attempt=2: 20ms
      await vi.advanceTimersByTimeAsync(100);
      const results = await promise;

      expect(results[0].success).toBe(false);
      expect(results[0].attempts).toBe(3); // 1 initial + 2 retries
    }, 10000);

    it('should handle non-retryable errors immediately', async () => {
      const tasks: Task<void>[] = [
        async () => {
          throw new Error('Non-retryable error');
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          transient: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10000, backoffMultiplier: 2 },
        },
      });

      const results = await promise;

      expect(results[0].success).toBe(false);
      expect(results[0].attempts).toBe(1);
    });
  });

  describe('rate limit handling', () => {
    it('should use longer delay for rate limit errors', async () => {
      let attempts = 0;
      const tasks: Task<void>[] = [
        async () => {
          attempts++;
          if (attempts < 2) {
            const error = new Error('Rate limited');
            (error as unknown as { statusCode: number }).statusCode = 429;
            (error as unknown as { response: { headers: Record<string, string> } }).response = {
              headers: { 'retry-after': '2' },
            };
            throw error;
          }
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          rateLimit: {
            maxRetries: 3,
            baseDelayMs: 100,
            maxDelayMs: 60000,
            backoffMultiplier: 2,
            respectRetryAfter: true,
          },
        },
      });

      // Should wait for retry-after (2s = 2000ms)
      await vi.advanceTimersByTimeAsync(2500);
      const results = await promise;

      expect(results[0].success).toBe(true);
      expect(results[0].attempts).toBe(2);
    });
  });

  describe('cancellation', () => {
    it('should throw when signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const tasks: Task<void>[] = [async () => {}];

      await expect(runTasks(tasks, { signal: controller.signal })).rejects.toThrow(
        'Task scheduler cancelled'
      );
    });

    it('should cancel tasks during execution', async () => {
      const controller = new AbortController();
      const events: SchedulerEvent[] = [];

      const tasks: Task<number>[] = [
        async ({ signal }) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (signal.aborted) throw new Error('Task cancelled');
          return 1;
        },
        async ({ signal }) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (signal.aborted) throw new Error('Task cancelled');
          return 2;
        },
      ];

      const promise = runTasks(tasks, {
        concurrency: 2,
        signal: controller.signal,
        onEvent: (e) => {
          events.push(e);
        },
      });

      // Let first task complete, abort during second
      await vi.advanceTimersByTimeAsync(150);
      controller.abort();

      const results = await promise;

      // At least one task should be cancelled
      const cancelled = results.filter((r) => !r.success && r.error?.message === 'Task cancelled');
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('events', () => {
    it('should emit task-start events', async () => {
      const events: SchedulerEvent[] = [];
      const tasks: Task<void>[] = [async () => {}];

      await runTasks(tasks, {
        onEvent: (e) => {
          events.push(e);
        },
      });

      const startEvents = events.filter((e) => e.type === 'task-start');
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]).toMatchObject({ index: 0, attempt: 1 });
    });

    it('should emit task-success events', async () => {
      const events: SchedulerEvent[] = [];
      const tasks: Task<number>[] = [async () => 42];

      await runTasks(tasks, {
        onEvent: (e) => {
          events.push(e);
        },
      });

      const successEvents = events.filter((e) => e.type === 'task-success');
      expect(successEvents).toHaveLength(1);
      expect(successEvents[0]).toMatchObject({ index: 0, attempt: 1, value: 42 });
      expect(successEvents[0].elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('should emit task-error events for failures', async () => {
      const events: SchedulerEvent[] = [];
      const error = new Error('Failed');
      const tasks: Task<void>[] = [
        async () => {
          throw error;
        },
      ];

      await runTasks(tasks, {
        onEvent: (e) => {
          events.push(e);
        },
      });

      const errorEvents = events.filter((e) => e.type === 'task-error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        index: 0,
        attempt: 1,
        error,
        retryable: false, // Non-retryable by default classifier
      });
    });

    it('should emit task-retry events', async () => {
      const events: SchedulerEvent[] = [];
      let attempt = 0;

      const tasks: Task<void>[] = [
        async () => {
          attempt++;
          if (attempt < 2) {
            const error = new Error('Transient');
            (error as unknown as { code: string }).code = 'ECONNRESET';
            throw error;
          }
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          transient: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10000, backoffMultiplier: 2 },
        },
        onEvent: (e) => {
          events.push(e);
        },
      });

      await vi.advanceTimersByTimeAsync(200);
      await promise;

      const retryEvents = events.filter((e) => e.type === 'task-retry');
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0]).toMatchObject({ index: 0, attempt: 1 });
      expect(retryEvents[0].retryDelayMs).toBeGreaterThanOrEqual(100);
    });

    it('should emit task-cancel events', async () => {
      const controller = new AbortController();
      const events: SchedulerEvent[] = [];

      const tasks: Task<void>[] = [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
      ];

      const promise = runTasks(tasks, {
        signal: controller.signal,
        onEvent: (e) => {
          events.push(e);
        },
      });

      controller.abort();
      await promise;

      const cancelEvents = events.filter((e) => e.type === 'task-cancel');
      expect(cancelEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should not fail if event handler throws', async () => {
      const tasks: Task<number>[] = [async () => 42];

      const results = await runTasks(tasks, {
        onEvent: () => {
          throw new Error('Handler error');
        },
      });

      expect(results[0].success).toBe(true);
      expect(results[0].value).toBe(42);
    });
  });

  describe('timing metadata', () => {
    it('should track elapsedMs', async () => {
      const tasks: Task<void>[] = [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      ];

      const promise = runTasks(tasks);
      await vi.advanceTimersByTimeAsync(60);
      const results = await promise;

      expect(results[0].elapsedMs).toBeGreaterThanOrEqual(50);
    });

    it('should track lastRunMs separately from elapsedMs for retries', async () => {
      let attempt = 0;
      const tasks: Task<void>[] = [
        async () => {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (attempt < 2) {
            const error = new Error('Transient');
            (error as unknown as { code: string }).code = 'ECONNRESET';
            throw error;
          }
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          transient: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 10000, backoffMultiplier: 2 },
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      const results = await promise;

      // lastRunMs should be the final successful run (around 30ms)
      expect(results[0].lastRunMs).toBeGreaterThanOrEqual(25);
      expect(results[0].lastRunMs).toBeLessThanOrEqual(50);

      // elapsedMs should include retry delays (30 + 10 + 30 = 70+)
      expect(results[0].elapsedMs).toBeGreaterThanOrEqual(60);
    });
  });

  describe('task context', () => {
    it('should provide correct context to task', async () => {
      const contexts: { index: number; attempt: number }[] = [];

      const tasks: Task<void>[] = [
        async (ctx) => {
          contexts.push({ index: ctx.index, attempt: ctx.attempt });
        },
      ];

      await runTasks(tasks);

      expect(contexts).toEqual([{ index: 0, attempt: 1 }]);
    });

    it('should increment attempt in context for retries', async () => {
      const contexts: { index: number; attempt: number }[] = [];
      let callCount = 0;

      const tasks: Task<void>[] = [
        async (ctx) => {
          contexts.push({ index: ctx.index, attempt: ctx.attempt });
          callCount++;
          if (callCount < 2) {
            const error = new Error('Transient');
            (error as unknown as { code: string }).code = 'ECONNRESET';
            throw error;
          }
        },
      ];

      const promise = runTasks(tasks, {
        retry: {
          transient: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 10000, backoffMultiplier: 2 },
        },
      });

      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(contexts).toEqual([
        { index: 0, attempt: 1 },
        { index: 0, attempt: 2 },
      ]);
    });
  });
});
