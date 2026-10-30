/**
 * Brain configuration from the environment, validated with Zod: the
 * providers in preference order. Only when `FACTORY_BRAIN_GATEWAY=1` does
 * Anthropic through the JigJoy gateway (`JIGJOY_ANTHROPIC_*`, both required)
 * come first; otherwise those variables are ignored. Then Z.ai (`ZAI_*`,
 * with its vendor fields); then an optional OpenAI-compatible fallback
 * (`FALLBACK_*`, no vendor fields). The `ANTHROPIC_*` names are never read:
 * Claude Code would pick them up.
 *
 * Invariant: a parse error names the variable and never carries a value
 * read from the environment, so a key cannot leak through an error.
 */

import { z } from 'zod';

/** Default OpenAI-compatible endpoint of the primary provider. */
export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
/** Default model of the primary provider. */
export const DEFAULT_ZAI_MODEL = 'glm-5.3-flash';

/**
 * Vendor fields merged into every request to the primary (Z.ai) provider:
 * thinking off. Measured live on 2026-10-30 with glm-5.3-flash: a short
 * answer took 7.5 to 10.7 s with 159 to 319 reasoning tokens by default,
 * 1.8 to 3.7 s with 9 to 17 reasoning tokens with thinking disabled.
 */
export const ZAI_EXTRA_BODY: Readonly<Record<string, unknown>> = { thinking: { type: 'disabled' } };

/** Default model behind the JigJoy Anthropic gateway (answers there; the 5.5 models return 503). */
export const DEFAULT_JIGJOY_MODEL = 'claude-sonnet-4-6';

/** The wire protocol of a provider. */
export type ProviderApi = 'openai-chat' | 'anthropic-messages';

/** One provider: its protocol, where to call, with which key and model, and its fixed vendor request fields. */
export interface ProviderConfig {
  readonly name: string;
  readonly api: ProviderApi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/** The validated brain configuration: the providers in preference order, never empty, with unique models. */
export interface BrainConfig {
  readonly providers: readonly [ProviderConfig, ...ProviderConfig[]];
}

/** A configuration error naming the offending variable. */
export class BrainConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super(`${variable} ${problem}; see .env.example`);
    this.name = 'BrainConfigError';
    this.variable = variable;
  }
}

const FALLBACK_VARIABLES = ['FALLBACK_API_KEY', 'FALLBACK_BASE_URL', 'FALLBACK_MODEL'] as const;

/** A provider URL; plain http stays allowed for the local fakes. */
const ProviderUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });

const EnvSchema = z.object({
  FACTORY_BRAIN_GATEWAY: z.string().optional(),
  JIGJOY_ANTHROPIC_API_KEY: z.string().optional(),
  JIGJOY_ANTHROPIC_BASE_URL: ProviderUrl.optional(),
  JIGJOY_ANTHROPIC_MODEL: z.string().default(DEFAULT_JIGJOY_MODEL),
  ZAI_API_KEY: z.string({ error: 'is required' }),
  ZAI_BASE_URL: ProviderUrl.default(DEFAULT_ZAI_BASE_URL),
  ZAI_MODEL: z.string().default(DEFAULT_ZAI_MODEL),
  FALLBACK_API_KEY: z.string().optional(),
  FALLBACK_BASE_URL: ProviderUrl.optional(),
  FALLBACK_MODEL: z.string().optional(),
});

/** A blank value counts as unset, as `.env` files write `NAME=` for "not set". */
function present(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed) out[name] = trimmed;
  }
  return out;
}

/** The gateway provider when `FACTORY_BRAIN_GATEWAY=1` (both variables then required), `undefined` when the flag is off. */
function gatewayOf(vars: z.infer<typeof EnvSchema>): ProviderConfig | undefined {
  if (vars.FACTORY_BRAIN_GATEWAY !== '1') return undefined;
  const { JIGJOY_ANTHROPIC_API_KEY: apiKey, JIGJOY_ANTHROPIC_BASE_URL: baseUrl } = vars;
  if (apiKey === undefined) throw new BrainConfigError('JIGJOY_ANTHROPIC_API_KEY', 'is required when FACTORY_BRAIN_GATEWAY=1');
  if (baseUrl === undefined) throw new BrainConfigError('JIGJOY_ANTHROPIC_BASE_URL', 'is required when FACTORY_BRAIN_GATEWAY=1');
  return { name: 'jigjoy', api: 'anthropic-messages', apiKey, baseUrl, model: vars.JIGJOY_ANTHROPIC_MODEL };
}

/** The OpenAI-compatible fallback when all of its variables are set, `undefined` when none is. */
function fallbackOf(vars: z.infer<typeof EnvSchema>): ProviderConfig | undefined {
  const { FALLBACK_API_KEY: apiKey, FALLBACK_BASE_URL: baseUrl, FALLBACK_MODEL: model } = vars;
  if (apiKey === undefined && baseUrl === undefined && model === undefined) return undefined;
  if (apiKey === undefined || baseUrl === undefined || model === undefined) {
    const missing = FALLBACK_VARIABLES.find((name) => vars[name] === undefined) ?? 'FALLBACK_API_KEY';
    throw new BrainConfigError(missing, 'is required when any FALLBACK_* variable is set');
  }
  return { name: 'fallback', api: 'openai-chat', apiKey, baseUrl, model };
}

/** Reads and validates the brain configuration; throws `BrainConfigError`. */
export function parseBrainConfig(env: Record<string, string | undefined>): BrainConfig {
  const parsed = EnvSchema.safeParse(present(env));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BrainConfigError(String(issue?.path[0] ?? 'environment'), issue?.message ?? 'is invalid');
  }
  const vars = parsed.data;
  const zai: ProviderConfig = {
    name: 'zai',
    api: 'openai-chat',
    apiKey: vars.ZAI_API_KEY,
    baseUrl: vars.ZAI_BASE_URL,
    model: vars.ZAI_MODEL,
    extraBody: ZAI_EXTRA_BODY,
  };
  const gateway = gatewayOf(vars);
  const fallback = fallbackOf(vars);
  // The runner routes calls by model name, so two providers cannot serve the same one.
  if (gateway !== undefined && gateway.model === zai.model)
    throw new BrainConfigError('JIGJOY_ANTHROPIC_MODEL', 'must differ from ZAI_MODEL');
  if (fallback !== undefined && (fallback.model === zai.model || fallback.model === gateway?.model)) {
    throw new BrainConfigError('FALLBACK_MODEL', 'must differ from ZAI_MODEL and JIGJOY_ANTHROPIC_MODEL');
  }
  const rest = fallback === undefined ? [] : [fallback];
  return { providers: gateway === undefined ? [zai, ...rest] : [gateway, zai, ...rest] };
}
