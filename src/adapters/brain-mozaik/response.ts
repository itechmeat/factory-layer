/**
 * Validation of a successful provider response and the mapping of its token
 * usage, for both wire shapes the brain speaks: chat completions and
 * Anthropic messages. Mozaik's mappers read the raw message unchecked,
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

/**
 * Token usage of one call: measured from the provider, or unavailable with
 * the reason (`call_failed`: the call failed; `abandoned`: the attempt
 * stopped waiting for it).
 */
export type Usage =
  | {
      readonly kind: 'measured';
      readonly input: number;
      readonly output: number;
      /** Prompt tokens read from or written to the provider's cache, billed apart from `input` (Anthropic). */
      readonly cacheRead: number;
      readonly cacheWrite: number;
    }
  | { readonly kind: 'unavailable'; readonly reason: 'missing' | 'invalid_usage' | 'call_failed' | 'abandoned' };

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

const AnthropicText = z.looseObject({ type: z.literal('text'), text: z.string() });
const AnthropicToolUse = z.looseObject({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() });
const AnthropicBlock = z.union([
  AnthropicText,
  AnthropicToolUse,
  z.looseObject({ type: z.string().refine((type) => type !== 'text' && type !== 'tool_use') }),
]);

/** The raw Anthropic messages shape Mozaik's mapper reads: a list of typed content blocks. */
const RawAnthropicResponse = z.looseObject({ type: z.literal('message'), content: z.array(AnthropicBlock) });

/** Anthropic's usage: the cache counts are outside `input_tokens`. */
const AnthropicCacheUsage = z.looseObject({
  usage: z.looseObject({
    cache_read_input_tokens: z.number().int().nonnegative().nullish(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  }),
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
  const anthropic = RawAnthropicResponse.safeParse(raw);
  if (anthropic.success) {
    const usable = anthropic.data.content.some(
      (block) => AnthropicToolUse.safeParse(block).success || (AnthropicText.safeParse(block).data?.text.trim() ?? '').length > 0,
    );
    return usable ? undefined : 'neither text nor a function call';
  }
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

const NamedModel = z.looseObject({ model: z.string().min(1) });

/** The model the raw provider answer names (chat completions carry `model`), or `undefined`. */
export function reportedModel(output: InferenceOutput): string | undefined {
  return NamedModel.safeParse(output.rowResponse).data?.model;
}

/**
 * Maps Mozaik's token usage to a measured or unavailable `Usage`. The cache
 * counts come from the raw answer: Mozaik merges Anthropic's read and write
 * counts into one figure, and they are priced differently. A chat-completions
 * answer counts cached tokens inside its prompt tokens, so its cache counts are 0.
 */
export function mapUsage(tokenUsage: TokenUsage | undefined, raw?: unknown): Usage {
  if (tokenUsage === undefined) return { kind: 'unavailable', reason: 'missing' };
  const counts = Counts.safeParse(tokenUsage);
  if (!counts.success) return { kind: 'unavailable', reason: 'invalid_usage' };
  const cache = AnthropicCacheUsage.safeParse(raw).data?.usage;
  return {
    kind: 'measured',
    input: counts.data.inputTokens,
    output: counts.data.outputTokens,
    cacheRead: cache?.cache_read_input_tokens ?? 0,
    cacheWrite: cache?.cache_creation_input_tokens ?? 0,
  };
}
