/**
 * Validation of a successful provider response and the mapping of its token
 * usage. Mozaik's OpenAI-compatible mapper reads the raw message unchecked,
 * turns a response without a message into empty items and copies token
 * counts unchecked; here the raw message is checked with Zod before that
 * mapper runs, the mapped items are checked for something a loop can use,
 * and the counts are checked before they count as measured.
 *
 * Invariants: an unusable or unreadable answer is a retryable
 * `malformed_response`, never a provider or network failure; usage is
 * measured only when both counts are non-negative integers.
 */

import { FunctionCallItem, ModelMessageItem, type Endpoint, type InferenceOutput, type TokenUsage } from '@mozaik-ai/core';
import { z } from 'zod';

import { BrainError } from './errors';

/** Token usage of one call: measured from the provider, or unavailable with the reason. */
export type Usage =
  | { readonly kind: 'measured'; readonly input: number; readonly output: number }
  | { readonly kind: 'unavailable'; readonly reason: 'missing' | 'invalid_usage' };

type Where = { readonly provider: string; readonly model: string };
type EndpointMapper = Endpoint['endpointMapper'];

const RawToolCall = z.looseObject({
  id: z.string(),
  type: z.literal('function'),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});

const RawMessage = z.looseObject({
  content: z.string().nullish(),
  reasoning_content: z.string().nullish(),
  tool_calls: z.array(RawToolCall).nullish(),
});

/** The raw chat-completions shape Mozaik's mapper reads: a first choice carrying a well-formed message. */
const RawChatResponse = z.looseObject({
  choices: z.tuple([z.looseObject({ message: RawMessage })], z.unknown()),
});

const Counts = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/** A retryable malformed-response error naming the provider and model. */
export function malformed(where: Where, problem: string): BrainError {
  return new BrainError('malformed_response', `${where.provider}/${where.model} answered with ${problem}`, {
    retryable: true,
    provider: where.provider,
    model: where.model,
  });
}

/** The problem with a raw response, or `undefined` when it is a usable answer. */
function rawProblem(raw: unknown): string | undefined {
  const parsed = RawChatResponse.safeParse(raw);
  if (!parsed.success) return 'no first choice with a well-formed message';
  const message = parsed.data.choices[0].message;
  const hasText = (message.content ?? '').trim().length > 0;
  const hasCall = (message.tool_calls ?? []).length > 0;
  return hasText || hasCall ? undefined : 'neither text nor a function call';
}

/** A usable item is a non-blank assistant message or a function call; reasoning alone is not. */
function isUsable(item: InferenceOutput['items'][number]): boolean {
  if (item instanceof FunctionCallItem) return true;
  return item instanceof ModelMessageItem && item.content.text.trim().length > 0;
}

/**
 * Wraps a Mozaik endpoint mapper so every raw response is validated before
 * the mapper reads it, and a mapper exception is a malformed response.
 */
export function validatingMapper(inner: EndpointMapper, where: Where): EndpointMapper {
  return {
    toRequest: (input): unknown => inner.toRequest(input),
    toResponse: (raw: unknown) => {
      const problem = rawProblem(raw);
      if (problem !== undefined) throw malformed(where, problem);
      try {
        return inner.toResponse(raw);
      } catch (error) {
        throw malformed(where, `a response the mapper could not read (${error instanceof Error ? error.name : 'unknown error'})`);
      }
    },
  };
}

/** A retryable malformed-response error when the output is unusable, otherwise `undefined`. */
export function malformedResponse(output: InferenceOutput, where: Where): BrainError | undefined {
  const problem = rawProblem(output.rowResponse) ?? (output.items.some((item) => isUsable(item)) ? undefined : 'no usable items');
  return problem === undefined ? undefined : malformed(where, problem);
}

/** Maps Mozaik's token usage to a measured or unavailable `Usage`. */
export function mapUsage(tokenUsage: TokenUsage | undefined): Usage {
  if (tokenUsage === undefined) return { kind: 'unavailable', reason: 'missing' };
  const counts = Counts.safeParse(tokenUsage);
  if (!counts.success) return { kind: 'unavailable', reason: 'invalid_usage' };
  return { kind: 'measured', input: counts.data.inputTokens, output: counts.data.outputTokens };
}
