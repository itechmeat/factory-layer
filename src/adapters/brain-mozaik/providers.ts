/**
 * Builds the guarded runner from the brain configuration: one
 * OpenAI-compatible endpoint per configured provider, the capabilities the
 * factory assumes for them, and the provider keys as the secrets every error
 * is redacted of. Every configured provider, the fallback included, is
 * assumed to accept the `ZAI_CAPABILITIES` profile. Every raw response passes `validatingMapper` before
 * Mozaik's own mapper reads it.
 */

import { OpenAIChatCompletions } from '@mozaik-ai/core';

import type { Clock } from '../../ports/index';
import type { BrainConfig, ProviderConfig } from './config';
import type { ModelCapabilities } from './request-checks';
import { validatingMapper } from './response';
import { GuardedInferenceRunner, type BrainProvider } from './runner';

/**
 * What the factory assumes of a Z.ai GLM model behind the OpenAI-compatible
 * endpoint: function calling and streaming; no structured output and no
 * reasoning-effort parameter (Mozaik's chat-completions mapper would send
 * `reasoning_effort`, which the endpoint does not document). Every configured
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

function provider(config: ProviderConfig): BrainProvider {
  // Mozaik 4.2.0 does not export its chat-completions mapper; a default endpoint carries one.
  const mozaikMapper = new OpenAIChatCompletions().endpointMapper;
  const mapper = validatingMapper(mozaikMapper, { provider: config.name, model: config.model });
  return {
    name: config.name,
    model: config.model,
    endpoint: new OpenAIChatCompletions(mapper, { baseURL: config.baseUrl, apiKey: config.apiKey }),
    capabilities: ZAI_CAPABILITIES,
  };
}

/** The guarded runner over the primary provider and, when configured, the fallback. */
export function createBrainRunner(config: BrainConfig, clock: Clock): GuardedInferenceRunner {
  const configured = config.fallback === undefined ? [config.primary] : [config.primary, config.fallback];
  return new GuardedInferenceRunner({
    providers: configured.map((entry) => provider(entry)),
    clock,
    secrets: configured.map((entry) => entry.apiKey),
  });
}
