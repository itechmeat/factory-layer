import { describe, expect, test } from 'bun:test';

import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  ReasoningItem,
  SystemMessageItem,
  UserMessageItem,
  type InferenceInput,
} from '@mozaik-ai/core';

import { contextItemKey, findRequestViolation, type ModelCapabilities } from './request-checks';

const FULL: ModelCapabilities = {
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ['low', 'high'],
  supportsFunctionCalling: true,
  supportsStreaming: true,
  supportsStructuredOutput: true,
  supportedContextItemTypes: [
    'user_message',
    'system_message',
    'developer_message',
    'model_message',
    'function_call',
    'function_call_output',
    'reasoning',
  ],
};

function input(extra: Partial<InferenceInput> = {}): InferenceInput {
  const context = ModelContext.create().addContextItem(UserMessageItem.create('hi'));
  return { model: 'm', context, ...extra };
}

describe('contextItemKey', () => {
  test('messages are told apart by role, other items by type', () => {
    expect(contextItemKey(UserMessageItem.create('a'))).toBe('user_message');
    expect(contextItemKey(SystemMessageItem.create('a'))).toBe('system_message');
    expect(contextItemKey(DeveloperMessageItem.create('a'))).toBe('developer_message');
    expect(contextItemKey(ModelMessageItem.rehydrate({ text: 'a' }))).toBe('model_message');
    expect(contextItemKey(FunctionCallItem.rehydrate({ callId: 'c', name: 'n', args: '{}' }))).toBe('function_call');
    expect(contextItemKey(FunctionCallOutputItem.create('c', 'out'))).toBe('function_call_output');
    expect(contextItemKey(ReasoningItem.rehydrate({ content: undefined, encryptedContent: undefined, summary: [] }))).toBe('reasoning');
  });
});

describe('findRequestViolation', () => {
  test('a plain request on a capable model passes', () => {
    expect(
      findRequestViolation(input({ reasoningEffort: 'low', tools: [], streaming: true, structuredOutput: { schema: {} } }), FULL),
    ).toBeUndefined();
  });

  test('reasoning effort: unsupported model or effort outside the allowlist', () => {
    expect(findRequestViolation(input({ reasoningEffort: 'low' }), { ...FULL, supportsReasoningEffort: false })).toBe('reasoning-effort');
    expect(findRequestViolation(input({ reasoningEffort: 'max' }), FULL)).toBe('reasoning-effort');
  });

  test('tools without function calling', () => {
    expect(findRequestViolation(input({ tools: [] }), { ...FULL, supportsFunctionCalling: false })).toBe('tool-calling');
  });

  test('streaming on a model without streaming; streaming false is allowed', () => {
    expect(findRequestViolation(input({ streaming: true }), { ...FULL, supportsStreaming: false })).toBe('streaming');
    expect(findRequestViolation(input({ streaming: false }), { ...FULL, supportsStreaming: false })).toBeUndefined();
  });

  test('structured output on a model without it', () => {
    expect(findRequestViolation(input({ structuredOutput: { schema: {} } }), { ...FULL, supportsStructuredOutput: false })).toBe(
      'structured-output',
    );
  });

  test('a context item type the model does not accept', () => {
    expect(findRequestViolation(input(), { ...FULL, supportedContextItemTypes: ['system_message'] })).toBe('context');
  });
});
