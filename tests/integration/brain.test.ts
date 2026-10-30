import { beforeAll, describe, expect, test } from 'bun:test';

import { FunctionCallItem, ModelContext, SystemMessageItem, UserMessageItem } from '@mozaik-ai/core';
import { z } from 'zod';

import { systemClock } from '../../src/adapters/index';
import { parseBrainConfig, type ProviderConfig } from '../../src/adapters/brain-mozaik/config';
import type { BrainRole } from '../../src/adapters/brain-mozaik/decision';
import { createMozaikDecider, type MozaikDecider } from '../../src/adapters/brain-mozaik/decider';
import { BrainError } from '../../src/adapters/brain-mozaik/errors';
import { ROLE_PROMPTS } from '../../src/adapters/brain-mozaik/prompts/index';
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

/** The attempt deadline of one live decision, in milliseconds. */
const DECISION_DEADLINE_MS = 90_000;
/** The practice spec the decisions are made on. */
const PRACTICE_SPEC = new URL('../../examples/specs/wordfreq.md', import.meta.url);

/** A small local answer schema: a short list of titles, not the domain plan. */
const Titles = z.object({ titles: z.array(z.string().min(3)).min(2).max(10).describe('Short titles, one per item') });

let primary: ProviderConfig;
let decider: MozaikDecider;
let specText: string;

beforeAll(async () => {
  requireEnv('ZAI_API_KEY');
  const config = parseBrainConfig(process.env);
  primary = config.providers[0];
  decider = createMozaikDecider(config, systemClock);
  specText = await Bun.file(PRACTICE_SPEC).text();
});

/** One live decision; returns its titles and when it started and ended (ms since the epoch). */
async function timedTitles(
  role: BrainRole,
  system: string,
  ask: string,
): Promise<{ titles: string[]; startedMs: number; endedMs: number }> {
  const startedMs = Date.now();
  const result = await decider.decide({ role, system, user: `${ask}\n\n${specText}`, schema: Titles, deadlineMs: DECISION_DEADLINE_MS });
  const endedMs = Date.now();
  const calls = result.usage.map(
    (record) => `${record.provider}/${record.model} ${String(record.elapsedMs)} ms ${JSON.stringify(record.usage)}`,
  );
  console.info(
    `brain decide (${role}): ${String(endedMs - startedMs)} ms, ${String(result.value.titles.length)} titles; calls: ${calls.join('; ')}`,
  );
  expect(result.usage.every((record) => record.role === role)).toBe(true);
  return { titles: result.value.titles, startedMs, endedMs };
}

const TASK_TITLES = 'List only the titles of the plan tasks for this spec (not full tasks), in plan order.';
const CHECK_TITLES = 'List only short titles of the acceptance checks for this spec (not full checks).';

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
      const runner = createBrainRunner({ providers: [primary] }, systemClock);
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
      const runner = createBrainRunner({ providers: [{ ...primary, apiKey: wrongKey }] }, systemClock);
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
      const runner = createBrainRunner({ providers: [primary] }, systemClock);
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

  test(
    'one decision on the practice spec resolves with a typed answer through the submit tool',
    async () => {
      const { titles } = await timedTitles('architect', ROLE_PROMPTS.architect.plan, TASK_TITLES);
      expect(titles.length).toBeGreaterThanOrEqual(2);
    },
    BRAIN_SMOKE_TIMEOUT_MS,
  );

  test(
    'two decisions on different agents run as concurrent loops',
    async () => {
      const [plan, acceptance] = await Promise.all([
        timedTitles('architect', ROLE_PROMPTS.architect.plan, TASK_TITLES),
        timedTitles('acceptance_analyst', ROLE_PROMPTS.acceptance_analyst.acceptance, CHECK_TITLES),
      ]);
      expect(Math.max(plan.startedMs, acceptance.startedMs)).toBeLessThan(Math.min(plan.endedMs, acceptance.endedMs));
    },
    BRAIN_SMOKE_TIMEOUT_MS,
  );
});
