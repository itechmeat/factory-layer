import { describe, expect, test } from 'bun:test';

import { ModelContext, UserMessageItem, type InferenceInput, type SemanticEvent } from '@mozaik-ai/core';

import type { Clock } from '../../ports/index';
import { BrainError } from './errors';
import { answer, chunkEvent, FakeEndpoint, PERMISSIVE } from './testing/fake-endpoint';
import { GuardedInferenceRunner, STREAM_CLEANUP_MS } from './runner';

const clock: Clock = { now: () => new Date() };
const DEADLINE_MS = 40;
/** Slack for timer scheduling on a loaded machine. */
const SLACK_MS = 400;

const chunk = chunkEvent();

function setup(endpoint: FakeEndpoint): { runner: GuardedInferenceRunner; context: ModelContext; input: InferenceInput } {
  const runner = new GuardedInferenceRunner({
    providers: [{ name: 'zai', model: 'glm', endpoint, capabilities: PERMISSIVE }],
    clock,
    secrets: [],
  });
  const context = ModelContext.create().addContextItem(UserMessageItem.create('hi'));
  return { runner, context, input: { model: 'glm', context } };
}

async function timed(work: Promise<unknown>): Promise<{ error: BrainError; elapsedMs: number }> {
  const started = Date.now();
  try {
    await work;
  } catch (error) {
    if (error instanceof BrainError) return { error, elapsedMs: Date.now() - started };
    throw error;
  }
  throw new Error('expected a rejection');
}

async function drain(events: AsyncIterable<SemanticEvent>): Promise<number> {
  let count = 0;
  for await (const event of events) count += event.type.length > 0 ? 1 : 0;
  return count;
}

const never = Promise.withResolvers<never>().promise;

describe('GuardedInferenceRunner: attempt deadline', () => {
  test('a slow infer rejects with a timeout naming provider, model and deadline, and cancels the attempt', async () => {
    const endpoint = new FakeEndpoint({ infer: async () => Bun.sleep(1_000).then(() => answer()) });
    const { runner, context, input } = setup(endpoint);
    const attempt = runner.bind(context, { deadlineMs: DEADLINE_MS });
    const { error, elapsedMs } = await timed(runner.run(input));
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('zai/glm');
    expect(error.message).toContain(`${String(DEADLINE_MS)} ms`);
    expect(elapsedMs).toBeLessThan(DEADLINE_MS + SLACK_MS);
    expect(attempt.cancelled).toBe(true);
    expect((await timed(runner.run(input))).error.kind).toBe('cancelled');
    expect(endpoint.requests).toHaveLength(1);
  });

  test('an overdue result of synchronous work is a timeout, not a success', async () => {
    const busy = (): void => {
      const until = Date.now() + DEADLINE_MS * 2;
      while (Date.now() < until) {
        // blocks the event loop past the deadline, so no timer can fire first
      }
    };
    const endpoint = new FakeEndpoint({
      infer: async () => {
        busy();
        return answer();
      },
    });
    const { runner, context, input } = setup(endpoint);
    const attempt = runner.bind(context, { deadlineMs: DEADLINE_MS });
    expect((await timed(runner.run(input))).error.kind).toBe('timeout');
    expect(attempt.cancelled).toBe(true);
    expect(attempt.calls.map((call) => call.usage)).toEqual([{ kind: 'unavailable', reason: 'call_failed' }]);

    const streaming = setup(
      new FakeEndpoint({
        async *stream() {
          busy();
          yield chunk;
        },
      }),
    );
    const streamAttempt = streaming.runner.bind(streaming.context, { deadlineMs: DEADLINE_MS });
    const seen: SemanticEvent[] = [];
    const consume = async (): Promise<void> => {
      for await (const event of streaming.runner.stream({ ...streaming.input, streaming: true })) seen.push(event);
    };
    expect((await timed(consume())).error.kind).toBe('timeout');
    expect(seen).toHaveLength(0);
    expect(streamAttempt.cancelled).toBe(true);
  });

  test('a call made after the deadline passed is a timeout without a provider call', async () => {
    const endpoint = new FakeEndpoint();
    const { runner, context, input } = setup(endpoint);
    runner.bind(context, { deadlineMs: 1 });
    await Bun.sleep(5);
    expect((await timed(runner.run(input))).error.kind).toBe('timeout');
    expect(endpoint.requests).toHaveLength(0);
  });

  test('a stalled stream rejects with a timeout at the deadline', async () => {
    const endpoint = new FakeEndpoint({
      async *stream() {
        yield chunk;
        await never;
      },
    });
    const { runner, context, input } = setup(endpoint);
    const attempt = runner.bind(context, { deadlineMs: DEADLINE_MS });
    const { error, elapsedMs } = await timed(drain(runner.stream({ ...input, streaming: true })));
    expect(error.kind).toBe('timeout');
    expect(elapsedMs).toBeLessThan(DEADLINE_MS + SLACK_MS);
    expect(attempt.cancelled).toBe(true);
  });

  test('a stream that keeps emitting past the deadline still ends at the deadline', async () => {
    const endpoint = new FakeEndpoint({
      async *stream() {
        for (;;) {
          await Bun.sleep(5);
          yield chunk;
        }
      },
    });
    const { runner, context, input } = setup(endpoint);
    const attempt = runner.bind(context, { deadlineMs: DEADLINE_MS });
    const { error, elapsedMs } = await timed(drain(runner.stream({ ...input, streaming: true })));
    expect(error.kind).toBe('timeout');
    expect(elapsedMs).toBeLessThan(DEADLINE_MS + SLACK_MS);
    expect(attempt.cancelled).toBe(true);
  });
});

describe('GuardedInferenceRunner: stream cleanup', () => {
  test('an early consumer exit closes the provider stream', async () => {
    let closed = false;
    const endpoint = new FakeEndpoint({
      async *stream() {
        try {
          for (;;) {
            await Bun.sleep(1);
            yield chunk;
          }
        } finally {
          closed = true;
        }
      },
    });
    const { runner, context, input } = setup(endpoint);
    runner.bind(context, { deadlineMs: 5_000 });
    for await (const event of runner.stream({ ...input, streaming: true })) {
      expect(event).toBe(chunk);
      break;
    }
    expect(closed).toBe(true);
  });

  test('a provider stream whose close hangs or rejects does not hold up or crash the consumer', async () => {
    for (const close of [
      () => Promise.withResolvers<IteratorResult<SemanticEvent>>().promise,
      () => Promise.reject(new Error('close failed')),
    ]) {
      const iterable: AsyncIterable<SemanticEvent> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: chunk }),
          return: close,
        }),
      };
      const endpoint = new FakeEndpoint({ stream: () => iterable });
      const { runner, context, input } = setup(endpoint);
      runner.bind(context, { deadlineMs: 5_000 });
      const started = Date.now();
      for await (const event of runner.stream({ ...input, streaming: true })) {
        expect(event).toBe(chunk);
        break;
      }
      expect(Date.now() - started).toBeLessThan(STREAM_CLEANUP_MS + SLACK_MS);
    }
  });
});
