/**
 * Brain configuration from the environment: the primary provider (`ZAI_*`)
 * and an optional fallback (`FALLBACK_*`), validated with Zod.
 *
 * Invariant: a parse error names the variable and never carries a value
 * read from the environment, so a key cannot leak through an error.
 */

import { z } from 'zod';

/** Default OpenAI-compatible endpoint of the primary provider. */
export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
/** Default model of the primary provider. */
export const DEFAULT_ZAI_MODEL = 'glm-5.3-flash';

/** One OpenAI-compatible provider: where to call, with which key and model. */
export interface ProviderConfig {
  readonly name: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** The validated brain configuration. */
export interface BrainConfig {
  readonly primary: ProviderConfig;
  readonly fallback?: ProviderConfig;
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

/** Reads and validates the brain configuration; throws `BrainConfigError`. */
export function parseBrainConfig(env: Record<string, string | undefined>): BrainConfig {
  const parsed = EnvSchema.safeParse(present(env));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BrainConfigError(String(issue?.path[0] ?? 'environment'), issue?.message ?? 'is invalid');
  }
  const vars = parsed.data;
  const primary: ProviderConfig = { name: 'zai', apiKey: vars.ZAI_API_KEY, baseUrl: vars.ZAI_BASE_URL, model: vars.ZAI_MODEL };
  const { FALLBACK_API_KEY: apiKey, FALLBACK_BASE_URL: baseUrl, FALLBACK_MODEL: model } = vars;
  if (apiKey === undefined && baseUrl === undefined && model === undefined) return { primary };
  if (apiKey === undefined || baseUrl === undefined || model === undefined) {
    const missing = FALLBACK_VARIABLES.find((name) => vars[name] === undefined) ?? 'FALLBACK_API_KEY';
    throw new BrainConfigError(missing, 'is required when any FALLBACK_* variable is set');
  }
  // The runner routes calls by model name, so two providers cannot serve the same one.
  if (model === primary.model) throw new BrainConfigError('FALLBACK_MODEL', 'must differ from ZAI_MODEL');
  return { primary, fallback: { name: 'fallback', apiKey, baseUrl, model } };
}
