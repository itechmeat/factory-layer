/**
 * Typed brain inference errors, the classification of provider failures by
 * HTTP status (and, for an exhausted balance sent as a plain 400, by its
 * text), and the redaction of secrets from error text.
 *
 * Invariant: every message and cause a `BrainError` exposes has passed
 * through `redactSecrets`, so a provider key never appears in an error.
 */

import { z } from 'zod';

import { redactSecrets } from '../mcp-stdio/redaction';

/** What went wrong, from the caller's point of view. */
export type BrainErrorKind =
  | 'unbound' // the context belongs to no attempt
  | 'cancelled' // the attempt was cancelled before this call
  | 'request' // rejected before any network call (unknown model, unsupported request)
  | 'timeout' // the attempt deadline passed
  | 'provider' // the provider reported a failure
  | 'malformed_response' // the provider answered with nothing usable
  | 'invalid_arguments'; // a function call's arguments failed their schema

/** The provider failure class derived from the HTTP status. */
export type ProviderFailure = 'auth' | 'budget' | 'request' | 'rate_limit' | 'unavailable' | 'network';

interface BrainErrorDetails {
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;
  readonly failure?: ProviderFailure;
  readonly tool?: string;
  readonly cause?: Error;
}

/** A typed brain failure: a value the caller records, discriminated by `kind`. */
export class BrainError extends Error {
  readonly kind: BrainErrorKind;
  readonly retryable: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly failure: ProviderFailure | undefined;
  readonly tool: string | undefined;

  constructor(kind: BrainErrorKind, message: string, details: BrainErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'BrainError';
    this.kind = kind;
    this.retryable = details.retryable;
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
    this.failure = details.failure;
    this.tool = details.tool;
  }
}

const WithStatus = z.object({ status: z.number().int() });
const WithMessage = z.object({ message: z.string() });

/** How providers word an exhausted balance or plan quota (Anthropic sends it as a 400). */
const BUDGET_TEXT =
  /credit balance|insufficient (balance|credits|funds)|out of credits|exceeded your (current )?quota|quota exceeded|usage limit|limit exhausted|payment required/i;

function failureOf(status: number | undefined, text: string): ProviderFailure {
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || (status === 400 && BUDGET_TEXT.test(text))) return 'budget';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status >= 500) return 'unavailable';
  return 'request';
}

const RETRYABLE: Readonly<Record<ProviderFailure, boolean>> = {
  auth: false,
  budget: false,
  request: false,
  rate_limit: true,
  unavailable: true,
  network: true,
};

/** Turns whatever an endpoint threw into a redacted, classified provider error. */
export function classifyProviderError(error: unknown, where: { provider: string; model: string }, secrets: readonly string[]): BrainError {
  const status = WithStatus.safeParse(error).data?.status;
  const raw = WithMessage.safeParse(error).data?.message ?? String(error);
  const text = redactSecrets(raw, secrets);
  const failure = failureOf(status, text);
  const cause = new Error(text);
  cause.name = error instanceof Error ? error.name : 'Error';
  const statusText = status === undefined ? 'no status' : `status ${String(status)}`;
  return new BrainError('provider', `${where.provider}/${where.model} failed (${failure}, ${statusText}): ${text}`, {
    retryable: RETRYABLE[failure],
    provider: where.provider,
    model: where.model,
    ...(status === undefined ? {} : { status }),
    failure,
    cause,
  });
}
