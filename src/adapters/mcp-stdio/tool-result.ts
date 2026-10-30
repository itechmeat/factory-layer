/**
 * The shape of an MCP tool result as this client reads it, and the parsing
 * of its payload with a caller's Zod schema. Invariant: a payload reaches the
 * caller only after it matched the caller's schema.
 */

import { z } from 'zod';

import { McpValidationError } from './errors';
import { redactSecrets } from './redaction';

/** How much of a non-JSON text payload a validation message quotes, in characters. */
export const PAYLOAD_QUOTE_CHARS = 200;

const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });

/** A tool result: content items, optional structured content, the error flag. */
export const ToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })).default([]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** A validated tool result. */
export type ToolResult = z.infer<typeof ToolResultSchema>;

function textItems(result: ToolResult): string[] {
  return result.content.flatMap((item) => {
    const parsed = TextContentSchema.safeParse(item);
    return parsed.success ? [parsed.data.text] : [];
  });
}

/** The text of an error result, for the tool error message. */
export function toolErrorText(result: ToolResult): string {
  const texts = textItems(result);
  return texts.length > 0 ? texts.join('\n') : 'no error text';
}

function rawPayload(tool: string, result: ToolResult, secrets: readonly string[]): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = textItems(result);
  if (texts.length === 0) throw new McpValidationError(tool, 'no structured or text content');
  const text = texts.join('');
  try {
    return JSON.parse(text);
  } catch {
    // Redact the whole text before cutting it, so a secret crossing the cut leaks no prefix.
    const quote = redactSecrets(text, secrets).slice(0, PAYLOAD_QUOTE_CHARS);
    throw new McpValidationError(tool, `text content is not JSON: ${quote}`);
  }
}

/**
 * The structured content of a result (or its JSON text content when there is
 * no structured content), parsed with `schema`.
 */
export function parseToolPayload<T>(tool: string, result: ToolResult, schema: z.ZodType<T>, secrets: readonly string[]): T {
  const parsed = schema.safeParse(rawPayload(tool, result, secrets));
  if (!parsed.success) {
    throw new McpValidationError(tool, redactSecrets(z.prettifyError(parsed.error), secrets));
  }
  return parsed.data;
}
