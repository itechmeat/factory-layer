/**
 * Request checks run before any provider call: the five rules of Mozaik
 * 4.2.0's default request validator (reasoning effort, tool calling,
 * streaming, structured output, context item types), as one pure function
 * with the same semantics over the capabilities a provider declares.
 */

import {
  DeveloperMessageItem,
  ModelMessageItem,
  SystemMessageItem,
  UserMessageItem,
  type ContextItem,
  type InferenceInput,
} from '@mozaik-ai/core';

/** What a model accepts; mirrors the request-relevant part of Mozaik's model specification. */
export interface ModelCapabilities {
  readonly supportsReasoningEffort: boolean;
  readonly supportedReasoningEfforts: readonly string[];
  readonly supportsFunctionCalling: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsStructuredOutput: boolean;
  /** Keys as produced by `contextItemKey`, e.g. `user_message`, `function_call`. */
  readonly supportedContextItemTypes: readonly string[];
}

/** The rule a request broke, named as Mozaik names it. */
export type RequestRule = 'reasoning-effort' | 'tool-calling' | 'streaming' | 'structured-output' | 'context';

/** The capability key of a context item: messages by role, everything else by type. */
export function contextItemKey(item: ContextItem): string {
  if (item instanceof UserMessageItem) return 'user_message';
  if (item instanceof SystemMessageItem) return 'system_message';
  if (item instanceof DeveloperMessageItem) return 'developer_message';
  if (item instanceof ModelMessageItem) return 'model_message';
  return item.getType();
}

/** The first rule the request breaks on this model, or `undefined` when it passes all of them. */
export function findRequestViolation(input: InferenceInput, model: ModelCapabilities): RequestRule | undefined {
  const effort = input.reasoningEffort;
  if (effort !== undefined && !(model.supportsReasoningEffort && model.supportedReasoningEfforts.includes(effort)))
    return 'reasoning-effort';
  if (input.tools !== undefined && !model.supportsFunctionCalling) return 'tool-calling';
  if (input.streaming && !model.supportsStreaming) return 'streaming';
  if (input.structuredOutput !== undefined && !model.supportsStructuredOutput) return 'structured-output';
  const accepted = input.context.items.every((item) => model.supportedContextItemTypes.includes(contextItemKey(item)));
  return accepted ? undefined : 'context';
}
