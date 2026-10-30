import { describe, expect, test } from 'bun:test';

import {
  InputTokenDetails,
  ModelMessageItem,
  OpenAIChatCompletions,
  OutputTokenDetails,
  ReasoningItem,
  TokenUsage,
  type InferenceOutput,
} from '@mozaik-ai/core';

import { BrainError } from './errors';
import { malformedResponse, mapUsage, validatingMapper } from './response';

const where = { provider: 'zai', model: 'glm' };
const message = ModelMessageItem.rehydrate({ text: 'hello' });
const goodRaw = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };

function output(extra: Partial<InferenceOutput>): InferenceOutput {
  return { items: [message], tokenUsage: undefined, rowResponse: goodRaw, ...extra };
}

function usage(input: unknown, out: unknown): TokenUsage {
  // The provider mapper copies counts unchecked, so the runtime object can hold anything.
  return Object.assign(new TokenUsage(0, 0, 0, new InputTokenDetails(0), new OutputTokenDetails(0)), {
    inputTokens: input,
    outputTokens: out,
  });
}

describe('malformedResponse', () => {
  const bad: [string, InferenceOutput][] = [
    ['no choices', output({ rowResponse: { choices: [] } })],
    ['no choices field', output({ rowResponse: {} })],
    ['no message', output({ rowResponse: { choices: [{ finish_reason: 'stop' }] } })],
    ['a null message', output({ rowResponse: { choices: [{ message: null }] } })],
    ['no items', output({ items: [] })],
  ];
  for (const [name, value] of bad) {
    test(`${name} is a retryable malformed-response error`, () => {
      const error = malformedResponse(value, where);
      expect(error?.kind).toBe('malformed_response');
      expect(error?.retryable).toBe(true);
      expect(error?.provider).toBe('zai');
      expect(error?.model).toBe('glm');
    });
  }
});

describe('malformedResponse: usable items', () => {
  test('reasoning only is not usable', () => {
    const reasoning = ReasoningItem.rehydrate({ content: undefined, encryptedContent: 'opaque', summary: [] });
    expect(malformedResponse(output({ items: [reasoning] }), where)?.kind).toBe('malformed_response');
  });
});

describe('validatingMapper', () => {
  const mapper = validatingMapper(new OpenAIChatCompletions().endpointMapper, where);

  function raw(assistant: unknown): unknown {
    return { choices: [{ index: 0, message: assistant }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  }

  function rejected(response: unknown): BrainError {
    try {
      mapper.toResponse(response);
    } catch (error) {
      if (error instanceof BrainError) return error;
      throw error;
    }
    throw new Error('expected a malformed-response error');
  }

  const bad: [string, unknown][] = [
    ['numeric content', raw({ role: 'assistant', content: 42 })],
    [
      'a tool call without a string id',
      raw({ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'n', arguments: '{}' } }] }),
    ],
    [
      'a tool call with object arguments',
      raw({ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: {} } }] }),
    ],
    [
      'a tool call of another type',
      raw({ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'custom', function: { name: 'n', arguments: '{}' } }] }),
    ],
    ['reasoning only', raw({ role: 'assistant', content: '', reasoning_content: 'thinking' })],
    ['blank text and no tool call', raw({ role: 'assistant', content: '   ' })],
    ['no choices', { choices: [] }],
  ];
  for (const [name, response] of bad) {
    test(`${name} is a retryable malformed-response error`, () => {
      const error = rejected(response);
      expect(error.kind).toBe('malformed_response');
      expect(error.retryable).toBe(true);
      expect(error.provider).toBe('zai');
    });
  }

  test("an exception inside Mozaik's mapper is a malformed-response error", () => {
    const throwing = validatingMapper(
      {
        toRequest: () => ({}),
        toResponse: () => {
          throw new TypeError('cannot read properties of undefined');
        },
      },
      where,
    );
    expect(() => throwing.toResponse(raw({ role: 'assistant', content: 'hi' }))).toThrow(BrainError);
  });
});

describe('mapUsage', () => {
  test('no usage block is unavailable (missing)', () => {
    expect(mapUsage(undefined)).toEqual({ kind: 'unavailable', reason: 'missing' });
  });

  for (const [name, input, out] of [
    ['negative', -1, 3],
    ['fractional', 1.5, 3],
    ['missing', undefined, 3],
    ['non-numeric', '12', 3],
    ['negative output', 12, -1],
  ] as const) {
    test(`${name} counts are unavailable (invalid_usage)`, () => {
      expect(mapUsage(usage(input, out))).toEqual({ kind: 'unavailable', reason: 'invalid_usage' });
    });
  }
});
