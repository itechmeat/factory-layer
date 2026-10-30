/**
 * Test double of a Mozaik `Endpoint`: records every request it receives and
 * answers with a scripted `infer` or `stream`. Used by the runner's and the
 * decision loop's unit tests; no network.
 */

import {
  FunctionCallItem,
  InputTokenDetails,
  ModelMessageItem,
  OutputTokenDetails,
  SemanticEvent,
  TokenUsage,
  type Endpoint,
  type InferenceInput,
  type InferenceOutput,
} from '@mozaik-ai/core';

import type { ModelCapabilities } from '../request-checks';

/** Capabilities that accept every request the tests make. */
export const PERMISSIVE: ModelCapabilities = {
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ['low'],
  supportsFunctionCalling: true,
  supportsStreaming: true,
  supportsStructuredOutput: false,
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

/** A valid answer: one assistant message, measured usage, a raw response with a message. */
export function answer(
  text = 'hello',
  usage: TokenUsage | undefined = new TokenUsage(10, 2, 12, new InputTokenDetails(0), new OutputTokenDetails(0)),
): InferenceOutput {
  return {
    items: [ModelMessageItem.rehydrate({ text })],
    tokenUsage: usage,
    rowResponse: { choices: [{ message: { role: 'assistant', content: text } }] },
  };
}

/** A valid answer that calls one function with `args` (serialized as the model sends them). */
export function functionCall(name: string, args: unknown, callId = `call-${crypto.randomUUID()}`): InferenceOutput {
  const json = JSON.stringify(args);
  return {
    items: [FunctionCallItem.rehydrate({ callId, name, args: json })],
    tokenUsage: new TokenUsage(10, 2, 12, new InputTokenDetails(0), new OutputTokenDetails(0)),
    rowResponse: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: callId, type: 'function', function: { name, arguments: json } }],
          },
        },
      ],
    },
  };
}

/** An intermediate stream event (a raw chunk in a real stream). */
export function chunkEvent(): SemanticEvent {
  return SemanticEvent.create('chunk', 'fake', {});
}

/** The final event an OpenAI-compatible stream yields. */
export function outputEvent(output: InferenceOutput): SemanticEvent {
  return SemanticEvent.create('inference.output', 'fake', output);
}

interface Script {
  readonly infer?: (input: InferenceInput) => Promise<InferenceOutput>;
  readonly stream?: (input: InferenceInput) => AsyncIterable<SemanticEvent>;
}

/** An `Endpoint` that records requests and follows a script. */
export class FakeEndpoint implements Endpoint {
  readonly endpointMapper = {
    toRequest: (input: InferenceInput): unknown => input,
    toResponse: (response: InferenceOutput): InferenceOutput => response,
  };
  readonly requests: InferenceInput[] = [];
  private readonly script: Script;

  constructor(script: Script = {}) {
    this.script = script;
  }

  async infer(input: InferenceInput): Promise<InferenceOutput> {
    this.requests.push(input);
    return this.script.infer === undefined ? answer() : this.script.infer(input);
  }

  async *stream(input: InferenceInput): AsyncIterable<SemanticEvent> {
    this.requests.push(input);
    if (this.script.stream === undefined) {
      yield outputEvent(answer());
      return;
    }
    yield* this.script.stream(input);
  }
}
