import { describe, expect, test } from 'bun:test';

import { ModelContext, UserMessageItem } from '@mozaik-ai/core';

import type { Clock } from '../../ports/index';
import { GuardedInferenceRunner, PROVIDER_COOLDOWN_MS, PROVIDER_DOWN_MS } from './runner';
import { FakeEndpoint, PERMISSIVE } from './testing/fake-endpoint';

function failingWith(status: number): FakeEndpoint {
  return new FakeEndpoint({
    infer: async () => {
      throw Object.assign(new Error(`status ${String(status)}`), { status });
    },
  });
}

function setup(primary: FakeEndpoint): { runner: GuardedInferenceRunner; advance: (ms: number) => void } {
  let nowMs = 1_000_000;
  const clock: Clock = { now: () => new Date(nowMs) };
  const runner = new GuardedInferenceRunner({
    providers: [
      { name: 'zai', model: 'glm', endpoint: primary, capabilities: PERMISSIVE },
      { name: 'fallback', model: 'other', endpoint: new FakeEndpoint(), capabilities: PERMISSIVE },
    ],
    clock,
    secrets: [],
  });
  return { runner, advance: (ms) => (nowMs += ms) };
}

async function tryOnce(runner: GuardedInferenceRunner): Promise<void> {
  const context = ModelContext.create().addContextItem(UserMessageItem.create('hi'));
  runner.bind(context);
  await runner.run({ model: runner.chooseModel(), context }).catch(() => undefined);
}

describe('GuardedInferenceRunner: provider fallback and cooldown', () => {
  for (const [label, status] of [
    ['a rate limit', 429],
    ['an outage', 503],
  ] as const) {
    test(`${label} of the primary routes the next attempt to the fallback until the cooldown ends`, async () => {
      const { runner, advance } = setup(failingWith(status));
      expect(runner.chooseModel()).toBe('glm');
      await tryOnce(runner);
      expect(runner.chooseModel()).toBe('other');
      advance(PROVIDER_COOLDOWN_MS - 1);
      expect(runner.chooseModel()).toBe('other');
      advance(1);
      expect(runner.chooseModel()).toBe('glm');
    });
  }

  for (const [label, status] of [
    ['a rejected key', 401],
    ['a forbidden account', 403],
    ['an exhausted balance', 402],
  ] as const) {
    test(`${label} of the primary routes later attempts to the fallback for the long cooldown`, async () => {
      const { runner, advance } = setup(failingWith(status));
      await tryOnce(runner);
      expect(runner.chooseModel()).toBe('other');
      advance(PROVIDER_DOWN_MS - 1);
      expect(runner.chooseModel()).toBe('other');
      advance(1);
      expect(runner.chooseModel()).toBe('glm');
    });
  }

  test('an outage after a refusal keeps the longer park', async () => {
    const statuses = [401, 503];
    const primary = new FakeEndpoint({
      infer: async () => {
        const status = statuses.shift() ?? 503;
        throw Object.assign(new Error(`status ${String(status)}`), { status });
      },
    });
    const { runner, advance } = setup(primary);
    const late = ModelContext.create().addContextItem(UserMessageItem.create('hi'));
    runner.bind(late);
    await tryOnce(runner);
    await runner.run({ model: 'glm', context: late }).catch(() => undefined);
    advance(PROVIDER_COOLDOWN_MS);
    expect(runner.chooseModel()).toBe('other');
  });

  test('a malformed request keeps the primary', async () => {
    const { runner } = setup(failingWith(400));
    await tryOnce(runner);
    expect(runner.chooseModel()).toBe('glm');
  });

  test('when every provider cools down, the one that recovers first is chosen', async () => {
    const both = failingWith(429);
    let nowMs = 0;
    const runner = new GuardedInferenceRunner({
      providers: [
        { name: 'zai', model: 'glm', endpoint: both, capabilities: PERMISSIVE },
        { name: 'fallback', model: 'other', endpoint: both, capabilities: PERMISSIVE },
      ],
      clock: { now: () => new Date(nowMs) },
      secrets: [],
    });
    await tryOnce(runner);
    nowMs += 10;
    await tryOnce(runner);
    expect(runner.chooseModel()).toBe('glm');
  });
});
