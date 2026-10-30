/**
 * Builds the guarded runner from the brain configuration: one endpoint per
 * configured provider (OpenAI-compatible chat completions, or Anthropic
 * messages for the JigJoy gateway, with a bounded `max_tokens`, which the
 * Anthropic API requires and Mozaik leaves unset), the capabilities the
 * factory assumes for them, and the provider keys as the secrets every error
 * is redacted of, and each provider's fixed vendor fields merged into every
 * request. Every configured provider, the fallback included, is
 * assumed to accept the `ZAI_CAPABILITIES` profile. Every raw response passes `validatingMapper` before
 * Mozaik's own mapper reads it.
 */

import { AnthropicMessages, OpenAIChatCompletions, type Endpoint } from '@mozaik-ai/core';
import { z } from 'zod';

import type { Clock } from '../../ports/index';
import type { BrainConfig, ProviderConfig } from './config';
import type { ModelCapabilities } from './request-checks';
import { validatingMapper } from './response';
import { GuardedInferenceRunner, type BrainProvider } from './runner';

/**
 * What the factory assumes of a Z.ai GLM model behind the OpenAI-compatible
 * endpoint: function calling and streaming; no structured output and no
 * reasoning-effort parameter (Mozaik's chat-completions mapper would send
 * `reasoning_effort`, which the endpoint does not document; its Anthropic
 * mapper would turn on adaptive thinking). Every configured
 * provider, the fallback included, is assumed to accept this profile; the
 * capabilities are not configurable per provider.
 */
export const ZAI_CAPABILITIES: ModelCapabilities = {
  supportsReasoningEffort: false,
  supportedReasoningEfforts: [],
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

/** The `max_tokens` of every Anthropic request: far above any submit-tool answer, and under the SDK's non-streaming limit. */
export const ANTHROPIC_MAX_TOKENS = 8192;

type EndpointMapper = Endpoint['endpointMapper'];

/** Adds `max_tokens` to every Anthropic request that does not set one. */
function withMaxTokens(inner: EndpointMapper): EndpointMapper {
  return {
    toRequest: (input): unknown => {
      const request = z.record(z.string(), z.unknown()).parse(inner.toRequest(input));
      return { ...request, max_tokens: input.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS };
    },
    toResponse: (raw) => inner.toResponse(raw),
  };
}

function endpointOf(config: ProviderConfig): Endpoint {
  const where = { provider: config.name, model: config.model };
  const connection = { baseURL: config.baseUrl, apiKey: config.apiKey };
  if (config.api === 'anthropic-messages') {
    // Mozaik 4.2.0 does not export its mappers; a default endpoint carries one.
    const mapper = validatingMapper(withMaxTokens(new AnthropicMessages().endpointMapper), where);
    return new AnthropicMessages(mapper, connection);
  }
  const mapper = validatingMapper(new OpenAIChatCompletions().endpointMapper, where);
  return new OpenAIChatCompletions(mapper, {
    ...connection,
    ...(config.extraBody === undefined ? {} : { extraBody: { ...config.extraBody } }),
  });
}

function provider(config: ProviderConfig): BrainProvider {
  return { name: config.name, model: config.model, endpoint: endpointOf(config), capabilities: ZAI_CAPABILITIES };
}

/** The guarded runner over the configured providers, in preference order. */
export function createBrainRunner(config: BrainConfig, clock: Clock): GuardedInferenceRunner {
  const configured = config.providers;
  return new GuardedInferenceRunner({
    providers: configured.map((entry) => provider(entry)),
    clock,
    secrets: configured.map((entry) => entry.apiKey),
  });
}
