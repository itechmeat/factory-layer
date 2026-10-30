import { describe, expect, test } from 'bun:test';

import {
  InputTokenDetails,
  ModelContext,
  OutputTokenDetails,
  TokenUsage,
  UserMessageItem,
  type InferenceInput,
  type InferenceOutput,
  type SemanticEvent,
} from '@mozaik-ai/core';

import type { Clock } from '../../ports/index';
import { BrainError } from './errors';
import { answer, chunkEvent, FakeEndpoint, outputEvent, PERMISSIVE } from './testing/fake-endpoint';
import { BRAIN_ATTEMPT_DEADLINE_MS, GuardedInferenceRunner, type BrainProvider } from './runner';

const KEY = 'sk-runner-secret';
const realClock: Clock = { now: () => new Date() };

function provider(endpoint: FakeEndpoint, model = 'glm'): BrainProvider {
  return { name: 'zai', model, endpoint, capabilities: PERMISSIVE };
}

function runnerWith(endpoint: FakeEndpoint, clock: Clock = realClock): GuardedInferenceRunner {
  return new GuardedInferenceRunner({ providers: [provider(endpoint)], clock, secrets: [KEY] });
}

function request(context: ModelContext, extra: Partial<InferenceInput> = {}): InferenceInput {
  return { model: 'glm', context, ...extra };
}

function newContext(): ModelContext {
  return ModelContext.create().addContextItem(UserMessageItem.create('hi'));
}

async function rejection(promise: Promise<unknown>): Promise<BrainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

async function drain(events: AsyncIterable<SemanticEvent>): Promise<SemanticEvent[]> {
  const out: SemanticEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('GuardedInferenceRunner: construction and binding', () => {
  test('two providers with the same model name are refused', () => {
    const endpoint = new FakeEndpoint();
    expect(
      () => new GuardedInferenceRunner({ providers: [provider(endpoint), provider(endpoint)], clock: realClock, secrets: [] }),
    ).toThrow(/glm/);
  });

  test('a context can be bound to one attempt only', () => {
    const runner = runnerWith(new FakeEndpoint());
    const context = newContext();
    runner.bind(context);
    expect(() => runner.bind(context)).toThrow(/already bound/);
  });

  test('the default attempt deadline is 90 s from bind time', () => {
    const clock: Clock = { now: () => new Date(1_000) };
    const attempt = runnerWith(new FakeEndpoint(), clock).bind(newContext());
    expect(BRAIN_ATTEMPT_DEADLINE_MS).toBe(90_000);
    expect(attempt.deadlineMs).toBe(90_000);
    expect(attempt.expiresAtMs).toBe(91_000);
  });
});

describe('GuardedInferenceRunner: admission', () => {
  test('an unbound context is rejected without a call, for run and stream', async () => {
    const endpoint = new FakeEndpoint();
    const runner = runnerWith(endpoint);
    expect((await rejection(runner.run(request(newContext())))).kind).toBe('unbound');
    expect((await rejection(drain(runner.stream(request(newContext(), { streaming: true }))))).kind).toBe('unbound');
    expect(endpoint.requests).toHaveLength(0);
  });

  test('a cancelled attempt is rejected without a call', async () => {
    const endpoint = new FakeEndpoint();
    const runner = runnerWith(endpoint);
    const context = newContext();
    const attempt = runner.bind(context);
    attempt.cancel();
    expect(attempt.cancelled).toBe(true);
    const error = await rejection(runner.run(request(context)));
    expect(error.kind).toBe('cancelled');
    expect(error.retryable).toBe(false);
    expect((await rejection(drain(runner.stream(request(context, { streaming: true }))))).kind).toBe('cancelled');
    expect(endpoint.requests).toHaveLength(0);
  });

  test('cancelling one of two attempts leaves the other usable', async () => {
    const endpoint = new FakeEndpoint();
    const runner = runnerWith(endpoint);
    const first = newContext();
    const second = newContext();
    runner.bind(first).cancel();
    runner.bind(second);
    expect((await rejection(runner.run(request(first)))).kind).toBe('cancelled');
    await runner.run(request(second));
    expect(endpoint.requests.map((input) => input.context)).toEqual([second]);
  });

  test('an unknown model is a request error before any call', async () => {
    const endpoint = new FakeEndpoint();
    const runner = runnerWith(endpoint);
    const context = newContext();
    runner.bind(context);
    const error = await rejection(runner.run(request(context, { model: 'nope' })));
    expect(error.kind).toBe('request');
    expect(error.message).toContain('nope');
    expect(endpoint.requests).toHaveLength(0);
  });

  const unsupported: [string, Partial<InferenceInput>][] = [
    ['reasoning-effort', { reasoningEffort: 'max' }],
    ['structured-output', { structuredOutput: { schema: {} } }],
  ];
  for (const [rule, extra] of unsupported) {
    test(`a request breaking ${rule} is a request error before any call, for run and stream`, async () => {
      const endpoint = new FakeEndpoint();
      const runner = runnerWith(endpoint);
      const context = newContext();
      runner.bind(context);
      const error = await rejection(runner.run(request(context, extra)));
      expect(error.kind).toBe('request');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain(rule);
      expect((await rejection(drain(runner.stream(request(context, { ...extra, streaming: true }))))).kind).toBe('request');
      expect(endpoint.requests).toHaveLength(0);
    });
  }
});

describe('GuardedInferenceRunner: responses and usage', () => {
  test('valid output is returned unchanged and its call recorded as measured, with elapsed time from the clock', async () => {
    const reply = answer('hi there');
    let nowMs = 5_000;
    const clock: Clock = { now: () => new Date(nowMs) };
    const infer = async (): Promise<InferenceOutput> => {
      nowMs += 250;
      return reply;
    };
    const runner = runnerWith(new FakeEndpoint({ infer }), clock);
    const context = newContext();
    const attempt = runner.bind(context);
    expect(await runner.run(request(context))).toBe(reply);
    expect(attempt.calls).toEqual([{ provider: 'zai', model: 'glm', elapsedMs: 250, usage: { kind: 'measured', input: 10, output: 2 } }]);
  });

  test('a response without usage succeeds with unavailable usage', async () => {
    const runner = runnerWith(new FakeEndpoint({ infer: async () => ({ ...answer('x'), tokenUsage: undefined }) }));
    const context = newContext();
    const attempt = runner.bind(context);
    await runner.run(request(context));
    expect(attempt.calls[0]?.usage).toEqual({ kind: 'unavailable', reason: 'missing' });
  });

  test('a valid answer with a negative token count succeeds with invalid_usage', async () => {
    const usage = new TokenUsage(-5, 2, -3, new InputTokenDetails(0), new OutputTokenDetails(0));
    const runner = runnerWith(new FakeEndpoint({ infer: async () => answer('x', usage) }));
    const context = newContext();
    const attempt = runner.bind(context);
    await runner.run(request(context));
    expect(attempt.calls[0]?.usage).toEqual({ kind: 'unavailable', reason: 'invalid_usage' });
  });

  test('an empty response is a retryable malformed-response error', async () => {
    const empty: InferenceOutput = { items: [], tokenUsage: undefined, rowResponse: { choices: [] } };
    const runner = runnerWith(new FakeEndpoint({ infer: async () => empty }));
    const context = newContext();
    const attempt = runner.bind(context);
    const error = await rejection(runner.run(request(context)));
    expect(error.kind).toBe('malformed_response');
    expect(error.retryable).toBe(true);
    expect(attempt.calls).toHaveLength(0);
  });

  test('a stream passes its events through and records the final output', async () => {
    const chunk = chunkEvent();
    const runner = runnerWith(
      new FakeEndpoint({
        async *stream() {
          yield chunk;
          yield outputEvent(answer());
        },
      }),
    );
    const context = newContext();
    const attempt = runner.bind(context);
    const events = await drain(runner.stream(request(context, { streaming: true })));
    expect(events).toHaveLength(2);
    expect(events[0]).toBe(chunk);
    expect(attempt.calls[0]?.usage.kind).toBe('measured');
  });

  test('a stream that ends without an output, or with a malformed one, is a malformed-response error', async () => {
    const endless = runnerWith(
      new FakeEndpoint({
        async *stream() {
          yield chunkEvent();
        },
      }),
    );
    const first = newContext();
    endless.bind(first);
    expect((await rejection(drain(endless.stream(request(first, { streaming: true }))))).kind).toBe('malformed_response');

    const malformed = runnerWith(
      new FakeEndpoint({
        async *stream() {
          yield outputEvent({ items: [], tokenUsage: undefined, rowResponse: {} });
        },
      }),
    );
    const second = newContext();
    malformed.bind(second);
    expect((await rejection(drain(malformed.stream(request(second, { streaming: true }))))).kind).toBe('malformed_response');
  });

  test('a provider failure is classified and redacted', async () => {
    const failing = runnerWith(
      new FakeEndpoint({
        infer: async () => {
          throw Object.assign(new Error(`bad key ${KEY}`), { status: 401 });
        },
      }),
    );
    const context = newContext();
    failing.bind(context);
    const error = await rejection(failing.run(request(context)));
    expect(error.kind).toBe('provider');
    expect(error.failure).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(Bun.inspect(error)).not.toContain(KEY);
  });

  test('a stream failure is classified too', async () => {
    const failing = runnerWith(
      new FakeEndpoint({
        // Fails before its first event, as a stream whose HTTP request is refused does.
        async *stream() {
          yield* [];
          throw Object.assign(new Error('overloaded'), { status: 503 });
        },
      }),
    );
    const context = newContext();
    failing.bind(context);
    const error = await rejection(drain(failing.stream(request(context, { streaming: true }))));
    expect(error.failure).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });
});
