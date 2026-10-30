import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { FunctionCallOutputItem, type InferenceInput, type InferenceOutput } from '@mozaik-ai/core';
import { z } from 'zod';

import { DecisionError, SUBMIT_TOOL_NAME, type DecisionRequest } from './decision';
import { MozaikDecider } from './decider';
import { GuardedInferenceRunner } from './runner';
import { answer, FakeEndpoint, functionCall, PERMISSIVE } from './testing/fake-endpoint';

const clock = { now: () => new Date() };
const Pick = z.object({ playbook: z.enum(['scaffold', 'implement-task']) });

/** Every unhandled rejection seen while this file runs; Mozaik loops must never produce one. */
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => process.on('unhandledRejection', onUnhandled));
afterAll(() => process.off('unhandledRejection', onUnhandled));

function deciderOver(infer: (input: InferenceInput) => Promise<InferenceOutput>): { decider: MozaikDecider; endpoint: FakeEndpoint } {
  const endpoint = new FakeEndpoint({ infer });
  const runner = new GuardedInferenceRunner({
    providers: [{ name: 'zai', model: 'glm', endpoint, capabilities: PERMISSIVE }],
    clock,
    secrets: [],
  });
  return { decider: new MozaikDecider({ runner, clock, log: () => undefined }), endpoint };
}

function request(extra: Partial<DecisionRequest<z.infer<typeof Pick>>> = {}): DecisionRequest<z.infer<typeof Pick>> {
  return { role: 'architect', system: 'Pick a playbook.', user: 'The spec.', schema: Pick, deadlineMs: 5_000, ...extra };
}

async function failure(work: Promise<unknown>): Promise<{ error: DecisionError; ms: number }> {
  const started = performance.now();
  try {
    await work;
  } catch (error) {
    if (error instanceof DecisionError) return { error, ms: performance.now() - started };
    throw error;
  }
  throw new Error('expected a DecisionError');
}

/** The text of every tool output the model was shown in a request. */
function toolOutputs(input: InferenceInput | undefined): string[] {
  return (input?.context.items ?? []).filter((item) => item instanceof FunctionCallOutputItem).map((item) => item.output.text);
}

const settle = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
/** A provider call that never answers. */
const never = async (): Promise<never> =>
  new Promise<never>(() => {
    // never settles
  });

describe('MozaikDecider: submissions', () => {
  test('an invented playbook is answered with the allowed names, and the corrected submission resolves', async () => {
    let calls = 0;
    const { decider, endpoint } = deciderOver(async () =>
      functionCall(SUBMIT_TOOL_NAME, { playbook: calls++ === 0 ? 'deploy' : 'scaffold' }),
    );
    const result = await decider.decide(request());
    expect(result.value).toEqual({ playbook: 'scaffold' });
    expect(endpoint.requests).toHaveLength(2);
    const shown = toolOutputs(endpoint.requests[1]).join('\n');
    expect(shown).toContain('scaffold');
    expect(shown).toContain('implement-task');
    expect(result.usage.map((record) => [record.role, record.usage.kind])).toEqual([
      ['architect', 'measured'],
      ['architect', 'measured'],
    ]);
    await settle(20);
    expect(endpoint.requests).toHaveLength(2);
  });
});

describe('MozaikDecider: bounded attempts', () => {
  test('a model that never submits fails with no_submission and its usage', async () => {
    const { decider } = deciderOver(async () => answer('I think scaffold.'));
    const { error } = await failure(decider.decide(request()));
    expect(error.reason).toBe('no_submission');
    expect(error.retryable).toBe(true);
    expect(error.usage).toHaveLength(1);
  });

  test('a model that keeps submitting invalid answers stops at the step cap of 12 inferences', async () => {
    const { decider, endpoint } = deciderOver(async () => functionCall(SUBMIT_TOOL_NAME, { playbook: 'deploy' }));
    const { error } = await failure(decider.decide(request()));
    expect(error.reason).toBe('step_limit');
    expect(endpoint.requests).toHaveLength(12);
    expect(error.usage).toHaveLength(12);
  });

  test('a provider that never answers fails the attempt at its deadline with an unavailable usage record', async () => {
    const { decider } = deciderOver(never);
    const { error, ms } = await failure(decider.decide(request({ deadlineMs: 100 })));
    expect(error.reason).toBe('timeout');
    expect(ms).toBeLessThan(1_000);
    expect(error.usage.map((record) => record.usage.kind)).toEqual(['unavailable']);
  });

  test('a provider error fails its attempt at once, records the failed call, and leaves no unhandled rejection', async () => {
    const { decider } = deciderOver(async () => {
      throw Object.assign(new Error('overloaded'), { status: 503 });
    });
    const { error, ms } = await failure(decider.decide(request({ deadlineMs: 30_000 })));
    expect(error.reason).toBe('failed');
    expect(error.retryable).toBe(true);
    expect(ms).toBeLessThan(1_000);
    expect(error.usage).toEqual([
      expect.objectContaining({ role: 'architect', provider: 'zai', model: 'glm', usage: { kind: 'unavailable', reason: 'call_failed' } }),
    ]);
    await settle(20);
    expect(unhandled).toEqual([]);
  });
});

describe('MozaikDecider: cancellation', () => {
  test('aborting the signal rejects at once with cancelled, and no further inference runs', async () => {
    const { decider, endpoint } = deciderOver(async () => {
      await settle(150);
      return functionCall(SUBMIT_TOOL_NAME, { playbook: 'deploy' });
    });
    const controller = new AbortController();
    const pending = failure(decider.decide(request({ signal: controller.signal })));
    await settle(20);
    controller.abort();
    const { error, ms } = await pending;
    expect(error.reason).toBe('cancelled');
    expect(error.retryable).toBe(false);
    expect(ms).toBeLessThan(100);
    expect(error.usage.map((record) => record.usage)).toEqual([{ kind: 'unavailable', reason: 'abandoned' }]);
    await settle(250);
    expect(endpoint.requests).toHaveLength(1);
  });

  test('an already aborted signal is refused without a model call', async () => {
    const { decider, endpoint } = deciderOver(async () => answer());
    const { error } = await failure(decider.decide(request({ signal: AbortSignal.abort() })));
    expect(error.reason).toBe('cancelled');
    expect(endpoint.requests).toHaveLength(0);
  });
});
