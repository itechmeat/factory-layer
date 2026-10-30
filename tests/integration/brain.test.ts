import { beforeAll, describe, expect, test } from 'bun:test';

import { FunctionCallItem, ModelContext, SystemMessageItem, UserMessageItem } from '@mozaik-ai/core';
import { z } from 'zod';

import { systemClock } from '../../src/adapters/index';
import { parseBrainConfig, type ProviderConfig } from '../../src/adapters/brain-mozaik/config';
import { BrainError } from '../../src/adapters/brain-mozaik/errors';
import { createBrainRunner } from '../../src/adapters/brain-mozaik/providers';
import { parseFunctionCall, toFunctionTool, type ToolDeclaration } from '../../src/adapters/brain-mozaik/tools';
import { requireEnv } from './support/prerequisites';

/** Each brain scenario must be observed within this budget, in milliseconds. */
const BRAIN_SMOKE_TIMEOUT_MS = 120_000;
/**
 * The attempt deadline of the timeout scenario, in milliseconds: long enough
 * to pass admission, so a request is in flight when it fires, and shorter
 * than any real answer.
 */
const SHORT_DEADLINE_MS = 50;

const weather: ToolDeclaration<{ city: string }> = {
  name: 'get_weather',
  description: 'Returns the current weather for a city. The only source of weather data.',
  args: z.object({ city: z.string().min(1).describe('City name, for example "Oslo"') }),
};

/** Offered to the model but never invoked: the smoke only checks the call the model makes. */
const weatherTool = toFunctionTool(weather, async () => {
  throw new Error('the brain smoke never runs tools');
});

let primary: ProviderConfig;

beforeAll(() => {
  requireEnv('ZAI_API_KEY');
  primary = parseBrainConfig(process.env).primary;
});

function question(): ModelContext {
  return ModelContext.create().addContextItems([
    SystemMessageItem.create('You answer weather questions only by calling the get_weather tool. Never answer from memory.'),
    UserMessageItem.create('What is the weather in Oslo right now?'),
  ]);
}

/** Runs one scenario and returns its `BrainError`; a rate limit fails loudly instead of passing. */
async function brainFailure(work: Promise<unknown>): Promise<BrainError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('expected the call to fail with a BrainError');
}

function failOnRateLimit(error: BrainError): void {
  if (error.failure === 'rate_limit') throw new Error(`rate limited by ${primary.name}, not a pass: ${error.message}`);
}

describe('brain link (live provider)', () => {
  test(
    'the configured model performs a validated function call through the guarded runner',
    async () => {
      const runner = createBrainRunner({ primary }, systemClock);
      const context = question();
      const attempt = runner.bind(context);
      const output = await runner.run({ model: primary.model, context, tools: [weatherTool] }).catch((error: unknown) => {
        if (error instanceof BrainError) failOnRateLimit(error);
        throw error;
      });
      const call = output.items.find((item) => item instanceof FunctionCallItem);
      expect(call).toBeDefined();
      if (call === undefined) return;
      const parsed = parseFunctionCall(call, [weather]);
      expect(parsed.name).toBe('get_weather');
      expect(parsed.args.city.toLowerCase()).toContain('oslo');
      const record = attempt.calls[0];
      expect(record).toBeDefined();
      console.info(`brain smoke: model ${primary.model}, ${String(record?.elapsedMs)} ms, usage ${JSON.stringify(record?.usage)}`);
    },
    BRAIN_SMOKE_TIMEOUT_MS,
  );

  test(
    'a wrong key yields a non-retryable provider error that does not contain the key',
    async () => {
      const wrongKey = `factory-smoke-wrong-key-${crypto.randomUUID()}`;
      const runner = createBrainRunner({ primary: { ...primary, apiKey: wrongKey } }, systemClock);
      const context = question();
      runner.bind(context);
      const error = await brainFailure(runner.run({ model: primary.model, context }));
      failOnRateLimit(error);
      expect(error.kind).toBe('provider');
      expect(error.failure).toBe('auth');
      expect(error.retryable).toBe(false);
      expect([401, 403]).toContain(error.status ?? 0);
      const text = Bun.inspect(error);
      expect(text).not.toContain(wrongKey);
      expect(text).not.toContain(primary.apiKey);
    },
    BRAIN_SMOKE_TIMEOUT_MS,
  );

  test(
    'an attempt deadline shorter than any real answer yields a timeout error',
    async () => {
      const runner = createBrainRunner({ primary }, systemClock);
      const context = question();
      const attempt = runner.bind(context, { deadlineMs: SHORT_DEADLINE_MS });
      const error = await brainFailure(runner.run({ model: primary.model, context }));
      expect(error.kind).toBe('timeout');
      expect(error.message).toContain(primary.model);
      expect(error.message).toContain(`${String(SHORT_DEADLINE_MS)} ms`);
      expect(attempt.cancelled).toBe(true);
    },
    BRAIN_SMOKE_TIMEOUT_MS,
  );
});
