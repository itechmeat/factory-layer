import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ModelContext, UserMessageItem, type InferenceInput } from '@mozaik-ai/core';
import { z } from 'zod';

import { ZAI_EXTRA_BODY, type BrainConfig } from './config';
import { BrainError } from './errors';
import { ANTHROPIC_MAX_TOKENS, createBrainRunner } from './providers';

const KEY = 'sk-local-fake-secret';
const FALLBACK_KEY = 'sk-local-fallback-secret';
const clock = { now: () => new Date() };
/** A prompt the fake server answers with a tool call Mozaik's mapper cannot read. */
const MALFORMED_PROMPT = 'answer with a malformed message';

/** A local OpenAI-compatible server: a tool call for the right key, a 401 echoing the key otherwise. */
let server: ReturnType<typeof Bun.serve>;
/** How many requests the fake server has received. */
let requests = 0;
/** The JSON body of the last authorized request. */
let lastBody: unknown;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests += 1;
      const auth = request.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${KEY}`) {
        return Response.json({ error: { message: `Incorrect API key provided: ${auth.replace('Bearer ', '')}` } }, { status: 401 });
      }
      lastBody = await request.json();
      const body = z.object({ model: z.string(), messages: z.array(z.object({ content: z.unknown() }).loose()) }).parse(lastBody);
      if (JSON.stringify(body.messages).includes(MALFORMED_PROMPT)) {
        return Response.json({
          id: 'cmpl-2',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function' }] } }],
        });
      }
      return Response.json({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

function config(apiKey: string): BrainConfig {
  const baseUrl = `http://127.0.0.1:${String(server.port)}/v1`;
  return {
    providers: [
      { name: 'zai', api: 'openai-chat', apiKey, baseUrl, model: 'glm-test', extraBody: ZAI_EXTRA_BODY },
      { name: 'fallback', api: 'openai-chat', apiKey: FALLBACK_KEY, baseUrl, model: 'other-test' },
    ],
  };
}

async function brainFailure(work: Promise<unknown>): Promise<BrainError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('expected a BrainError');
}

function context(): ModelContext {
  return ModelContext.create().addContextItem(UserMessageItem.create('weather in Oslo?'));
}

describe('createBrainRunner', () => {
  const unsupported: [string, Partial<InferenceInput>][] = [
    ['reasoning effort', { reasoningEffort: 'low' }],
    ['structured output', { structuredOutput: { schema: {} } }],
  ];
  for (const [feature, extra] of unsupported) {
    test(`a request for ${feature} on the Z.ai model is a request error and nothing is sent`, async () => {
      const runner = createBrainRunner(config(KEY), clock);
      const ctx = context();
      runner.bind(ctx, { deadlineMs: 10_000 });
      const before = requests;
      const error = await brainFailure(runner.run({ model: 'glm-test', context: ctx, ...extra }));
      expect(error.kind).toBe('request');
      expect(requests).toBe(before);
    });
  }

  test('a malformed raw message is a retryable malformed-response error, not a provider failure', async () => {
    const runner = createBrainRunner(config(KEY), clock);
    const ctx = ModelContext.create().addContextItem(UserMessageItem.create(MALFORMED_PROMPT));
    runner.bind(ctx, { deadlineMs: 10_000 });
    const error = await brainFailure(runner.run({ model: 'glm-test', context: ctx }));
    expect(error.kind).toBe('malformed_response');
    expect(error.retryable).toBe(true);
  });

  test('the fallback model is in the table too', async () => {
    const runner = createBrainRunner(config(KEY), clock);
    const ctx = context();
    runner.bind(ctx, { deadlineMs: 10_000 });
    // The fake server accepts only the primary key, so reaching it with the fallback key proves the model is routed.
    const error = await brainFailure(runner.run({ model: 'other-test', context: ctx }));
    expect(error.provider).toBe('fallback');
    expect(error.failure).toBe('auth');
  });

  test('a rejected key is a non-retryable auth error without the key in it', async () => {
    const wrong = 'sk-wrong-key-value';
    const runner = createBrainRunner(config(wrong), clock);
    const ctx = context();
    runner.bind(ctx, { deadlineMs: 10_000 });
    const brainError = await brainFailure(runner.run({ model: 'glm-test', context: ctx }));
    expect(brainError.status).toBe(401);
    expect(brainError.retryable).toBe(false);
    expect(Bun.inspect(brainError)).not.toContain(wrong);
    expect(Bun.inspect(brainError)).not.toContain(FALLBACK_KEY);
  });

  test('a request to the Z.ai provider carries the field that disables thinking', async () => {
    const runner = createBrainRunner(config(KEY), clock);
    const ctx = context();
    runner.bind(ctx, { deadlineMs: 10_000 });
    await runner.run({ model: 'glm-test', context: ctx });
    expect(z.looseObject({ thinking: z.unknown() }).parse(lastBody).thinking).toEqual({ type: 'disabled' });
  });
});

describe('createBrainRunner with the Anthropic gateway', () => {
  const GATEWAY_KEY = 'sk-local-gateway-secret';
  let gateway: ReturnType<typeof Bun.serve>;
  let gatewayBody: unknown;
  let gatewayKey: string | null = null;

  beforeAll(() => {
    gateway = Bun.serve({
      port: 0,
      fetch: async (request) => {
        gatewayKey = request.headers.get('x-api-key');
        gatewayBody = await request.json();
        const { model } = z.looseObject({ model: z.string() }).parse(gatewayBody);
        return Response.json({
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          model,
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu-1', name: 'get_weather', input: { city: 'Oslo' } }],
          usage: { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 },
        });
      },
    });
  });

  afterAll(async () => {
    await gateway.stop(true);
  });

  const gatewayConfig = (): BrainConfig => ({
    providers: [
      {
        name: 'jigjoy',
        api: 'anthropic-messages',
        apiKey: GATEWAY_KEY,
        baseUrl: `http://127.0.0.1:${String(gateway.port)}`,
        model: 'claude-test',
      },
    ],
  });

  test('a tool call comes back as a function call, with max_tokens sent and cache counts measured apart', async () => {
    const runner = createBrainRunner(gatewayConfig(), clock);
    const ctx = context();
    const attempt = runner.bind(ctx, { deadlineMs: 10_000 });
    const tool = {
      type: 'function' as const,
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      strict: true,
      invoke: async () => 'sunny',
    };
    const output = await runner.run({ model: 'claude-test', context: ctx, tools: [tool] });
    expect(output.items.map((item) => item.type)).toEqual(['function_call']);
    expect(gatewayKey).toBe(GATEWAY_KEY);
    const body = z.looseObject({ max_tokens: z.number(), tools: z.array(z.looseObject({ input_schema: z.unknown() })) }).parse(gatewayBody);
    expect(body.max_tokens).toBe(ANTHROPIC_MAX_TOKENS);
    expect(body.tools).toHaveLength(1);
    expect(attempt.calls[0]?.usage).toEqual({ kind: 'measured', input: 30, output: 7, cacheRead: 100, cacheWrite: 40 });
    expect(attempt.calls[0]?.reportedModel).toBe('claude-test');
  });
});
