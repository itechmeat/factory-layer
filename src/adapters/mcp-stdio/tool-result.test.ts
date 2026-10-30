import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { McpValidationError } from './errors';
import { PAYLOAD_QUOTE_CHARS, parseToolPayload, toolErrorText, ToolResultSchema } from './tool-result';

const Shape = z.object({ count: z.number() });

describe('parseToolPayload', () => {
  test('parses structured content when present', () => {
    const result = ToolResultSchema.parse({
      content: [{ type: 'text', text: '{"count": 9}' }],
      structuredContent: { count: 1 },
    });
    expect(parseToolPayload('t', result, Shape, [])).toEqual({ count: 1 });
  });

  test('parses JSON text content when there is no structured content', () => {
    const result = ToolResultSchema.parse({ content: [{ type: 'text', text: '{"count": 2}' }] });
    expect(parseToolPayload('t', result, Shape, [])).toEqual({ count: 2 });
  });

  test('rejects a mismatching shape with a validation error naming the tool', () => {
    const result = ToolResultSchema.parse({ structuredContent: { count: 'many' } });
    expect(() => parseToolPayload('counter', result, Shape, [])).toThrow(McpValidationError);
    expect(() => parseToolPayload('counter', result, Shape, [])).toThrow(/counter/);
  });

  test('rejects text that is not JSON with a validation error', () => {
    const result = ToolResultSchema.parse({ content: [{ type: 'text', text: 'hello' }] });
    expect(() => parseToolPayload('t', result, Shape, [])).toThrow(McpValidationError);
  });

  test('rejects a result with neither structured nor text content', () => {
    const result = ToolResultSchema.parse({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] });
    expect(() => parseToolPayload('t', result, Shape, [])).toThrow(/no structured or text content/);
  });

  test('a secret crossing the quote limit leaks no prefix', () => {
    const secret = 'sk-boundary-secret-value';
    const text = `${'x'.repeat(PAYLOAD_QUOTE_CHARS - 5)}${secret}`;
    const result = ToolResultSchema.parse({ content: [{ type: 'text', text }] });
    expect(() => parseToolPayload('t', result, Shape, [secret])).toThrow(McpValidationError);
    expect(() => parseToolPayload('t', result, Shape, [secret])).not.toThrow(secret.slice(0, 5));
  });

  test('redacts secrets from the validation message', () => {
    const result = ToolResultSchema.parse({ content: [{ type: 'text', text: 'leak hush' }] });
    expect(() => parseToolPayload('t', result, Shape, ['hush'])).toThrow('leak [redacted]');
  });
});

describe('toolErrorText', () => {
  test('joins the text items of an error result', () => {
    const result = ToolResultSchema.parse({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      isError: true,
    });
    expect(toolErrorText(result)).toBe('first\nsecond');
  });

  test('says so when the error has no text', () => {
    expect(toolErrorText(ToolResultSchema.parse({ isError: true }))).toBe('no error text');
  });
});
