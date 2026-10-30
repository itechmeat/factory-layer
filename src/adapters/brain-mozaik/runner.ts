/**
 * The guarded inference runner: Mozaik's `InferenceRunner` over a table of
 * providers (OpenAI-compatible or Anthropic). It replaces Mozaik's default runner and keeps
 * its request checks, and adds what the factory's loop contract needs: every
 * call belongs to an attempt bound by its `ModelContext`, with one absolute
 * deadline and a cancellation flag; failures are typed, redacted and
 * recorded on the attempt with unavailable usage; responses are validated
 * and their usage recorded; a provider that failed with a retryable outage
 * cools down, so the next attempt is routed to the fallback.
 *
 * Mozaik 4.2.0 does not await or catch the loop it starts, so a runner error
 * inside a loop would become an unhandled rejection. An attempt bound with a
 * failure handler is therefore settled through that handler, and the runner
 * returns a synthetic final model message that ends the loop at idle.
 *
 * Invariants: no inference reaches a provider unless its context is bound to
 * a live attempt and the request passes the checks; a timeout cancels its
 * attempt; valid output is returned to Mozaik unchanged.
 */

import {
  ModelMessageItem,
  SemanticEvent,
  type Endpoint,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type ModelContext,
} from '@mozaik-ai/core';
import { z } from 'zod';

import type { Clock } from '../../ports/index';
import { Attempt, type AttemptFailureHandler } from './attempt';
import { raceDeadline } from './deadline';
import { BrainError, classifyProviderError } from './errors';
import { findRequestViolation, type ModelCapabilities } from './request-checks';
import { malformed, malformedResponse, mapUsage, reportedModel } from './response';

/** Default attempt budget, milliseconds from bind time. */
export const BRAIN_ATTEMPT_DEADLINE_MS = 90_000;
/** Longest wait for a provider stream to close after the consumer stopped early, milliseconds. */
export const STREAM_CLEANUP_MS = 1_000;
/** How long a provider is skipped after a retryable outage (rate limit, unavailable, network, timeout), milliseconds. */
export const PROVIDER_COOLDOWN_MS = 60_000;

/** One configured model: the endpoint that serves it and what it accepts. */
export interface BrainProvider {
  readonly name: string;
  readonly model: string;
  readonly endpoint: Endpoint;
  readonly capabilities: ModelCapabilities;
}

/** What the runner needs: the provider table in preference order, a clock, and the secrets to keep out of errors. */
export interface GuardedRunnerOptions {
  readonly providers: readonly BrainProvider[];
  readonly clock: Clock;
  readonly secrets: readonly string[];
  readonly cooldownMs?: number;
}

/** How an attempt is bound: its budget and, for a decision loop, the handler that settles its failures. */
export interface BindOptions {
  readonly deadlineMs?: number;
  readonly onFailure?: AttemptFailureHandler;
}

/** The provider failures after which a provider cools down. */
const OUTAGES: ReadonlySet<string> = new Set(['rate_limit', 'unavailable', 'network']);

/** The output that ends a loop at idle after its attempt was settled with a failure. */
function endOfAttempt(error: BrainError): InferenceOutput {
  const text = `The attempt ended: ${error.kind}.`;
  return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: undefined };
}

/** The shape of the final event payload of a stream. */
const OutputPayload = z.custom<InferenceOutput>(
  (value) => z.object({ items: z.array(z.unknown()), rowResponse: z.unknown() }).safeParse(value).success,
);

export class GuardedInferenceRunner implements InferenceRunner {
  readonly #providers = new Map<string, BrainProvider>();
  readonly #order: readonly BrainProvider[];
  readonly #coolingUntilMs = new Map<string, number>();
  readonly #attempts = new WeakMap<ModelContext, Attempt>();
  readonly #clock: Clock;
  readonly #secrets: readonly string[];
  readonly #cooldownMs: number;

  constructor(options: GuardedRunnerOptions) {
    for (const provider of options.providers) {
      if (this.#providers.has(provider.model))
        throw new Error(`Two providers serve the model "${provider.model}"; model names must be unique`);
      this.#providers.set(provider.model, provider);
    }
    this.#order = options.providers;
    this.#clock = options.clock;
    this.#secrets = options.secrets;
    this.#cooldownMs = options.cooldownMs ?? PROVIDER_COOLDOWN_MS;
  }

  /**
   * The model a new attempt should use: the first provider in preference
   * order that is not cooling down, else the one whose cooldown ends first.
   */
  chooseModel(): string {
    const nowMs = this.#nowMs();
    const until = (provider: BrainProvider): number => this.#coolingUntilMs.get(provider.model) ?? 0;
    const ready = this.#order.find((provider) => until(provider) <= nowMs);
    const chosen = ready ?? this.#order.toSorted((a, b) => until(a) - until(b))[0];
    if (chosen === undefined) throw new Error('The runner has no providers');
    return chosen.model;
  }

  /** Binds a context to a new attempt whose deadline starts now. One context, one attempt. */
  bind(context: ModelContext, options: BindOptions = {}): Attempt {
    if (this.#attempts.has(context)) throw new Error(`Context ${context.id} is already bound to an attempt`);
    const attempt = new Attempt(options.deadlineMs ?? BRAIN_ATTEMPT_DEADLINE_MS, this.#nowMs(), options.onFailure);
    this.#attempts.set(context, attempt);
    return attempt;
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    try {
      return await this.#run(input);
    } catch (error) {
      return this.#settle(input, error);
    }
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    let failure: InferenceOutput | undefined;
    try {
      yield* this.#stream(input);
    } catch (error) {
      failure = this.#settle(input, error);
    }
    if (failure !== undefined) yield SemanticEvent.create('inference.output', 'guarded-runner', failure);
  }

  /**
   * A failure of an attempt bound for a loop is handed to its handler and
   * answered with the synthetic final message; any other failure is thrown.
   */
  #settle(input: InferenceInput, error: unknown): InferenceOutput {
    const brainError = error instanceof BrainError ? error : this.#asBrainError(error, undefined);
    const handler = this.#attempts.get(input.context)?.onFailure;
    if (handler === undefined) throw brainError;
    handler(brainError);
    return endOfAttempt(brainError);
  }

  async #run(input: InferenceInput): Promise<InferenceOutput> {
    const { attempt, provider } = this.#admit(input);
    const startedMs = this.#nowMs();
    const ticket = attempt.start(provider.name, provider.model, startedMs);
    try {
      const output = await raceDeadline(provider.endpoint.infer(input), attempt.timeLeftMs(startedMs), () =>
        this.#timeout(attempt, provider),
      );
      this.#assertInTime(attempt, provider);
      return this.#accept(output, attempt, ticket, provider);
    } catch (error) {
      throw this.#failed(error, attempt, ticket, provider);
    }
  }

  async *#stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    const { attempt, provider } = this.#admit(input);
    const startedMs = this.#nowMs();
    const ticket = attempt.start(provider.name, provider.model, startedMs);
    const events = provider.endpoint.stream(input)[Symbol.asyncIterator]();
    let output: InferenceOutput | undefined;
    let exhausted = false;
    try {
      for (;;) {
        const left = attempt.timeLeftMs(this.#nowMs());
        if (left <= 0) throw this.#timeout(attempt, provider);
        const step = await raceDeadline(events.next(), left, () => this.#timeout(attempt, provider));
        this.#assertInTime(attempt, provider);
        if (step.done) {
          exhausted = true;
          break;
        }
        if (step.value.type === 'inference.output') {
          const payload = OutputPayload.safeParse(step.value.payload);
          if (!payload.success) throw this.#malformed(provider, 'a final event without an output');
          output = this.#accept(payload.data, attempt, ticket, provider);
        }
        yield step.value;
      }
    } catch (error) {
      this.#closeInBackground(events);
      exhausted = true;
      throw this.#failed(error, attempt, ticket, provider);
    } finally {
      // Reached without `exhausted` only when the consumer stopped early (`break` or `return()`).
      if (!exhausted) await this.#close(events);
    }
    if (output === undefined) {
      throw this.#failed(this.#malformed(provider, 'a stream that ended without an output'), attempt, ticket, provider);
    }
  }

  /** Records a failed call on its attempt, cools its provider down after an outage, and returns the typed error. */
  #failed(error: unknown, attempt: Attempt, ticket: number, provider: BrainProvider): BrainError {
    const brainError = this.#asBrainError(error, provider);
    const nowMs = this.#nowMs();
    attempt.fail(ticket, brainError.failure ?? brainError.kind, nowMs);
    if (brainError.kind === 'timeout' || (brainError.kind === 'provider' && OUTAGES.has(brainError.failure ?? ''))) {
      this.#coolingUntilMs.set(provider.model, nowMs + this.#cooldownMs);
    }
    return brainError;
  }

  /** A result that arrives after the deadline is a timeout, even if no timer could fire first. */
  #assertInTime(attempt: Attempt, provider: BrainProvider): void {
    if (attempt.timeLeftMs(this.#nowMs()) <= 0) throw this.#timeout(attempt, provider);
  }

  /** Closes a provider stream, waiting at most `STREAM_CLEANUP_MS`; a failed or slow close is ignored. */
  async #close(events: AsyncIterator<SemanticEvent>): Promise<void> {
    const closing = events.return?.(undefined);
    if (closing === undefined) return;
    await raceDeadline(closing, STREAM_CLEANUP_MS, () => new Error('provider stream close timed out')).catch(() => undefined);
  }

  /** Starts closing a failed provider stream without waiting; a rejection of the close is observed. */
  #closeInBackground(events: AsyncIterator<SemanticEvent>): void {
    const closing = events.return?.(undefined);
    if (closing !== undefined) void closing.catch(() => undefined);
  }

  #nowMs(): number {
    return this.#clock.now().getTime();
  }

  /** Every check that must pass before a provider is contacted. */
  #admit(input: InferenceInput): { attempt: Attempt; provider: BrainProvider } {
    const attempt = this.#attempts.get(input.context);
    if (attempt === undefined) {
      throw new BrainError('unbound', `Context ${input.context.id} is not bound to an attempt; bind it before inference`, {
        retryable: false,
      });
    }
    if (attempt.cancelled) {
      throw new BrainError('cancelled', `The attempt of context ${input.context.id} is cancelled`, {
        retryable: false,
        model: input.model,
      });
    }
    const provider = this.#providers.get(input.model);
    if (provider === undefined) {
      const known = [...this.#providers.keys()].join(', ');
      throw new BrainError('request', `Unknown model "${input.model}"; configured: ${known}`, { retryable: false, model: input.model });
    }
    if (attempt.timeLeftMs(this.#nowMs()) <= 0) throw this.#timeout(attempt, provider);
    const rule = findRequestViolation(input, provider.capabilities);
    if (rule !== undefined) {
      throw new BrainError('request', `Request check "${rule}" failed for ${provider.name}/${provider.model}`, {
        retryable: false,
        provider: provider.name,
        model: provider.model,
      });
    }
    return { attempt, provider };
  }

  /** Validates an output, records the call on the attempt and returns the output unchanged. */
  #accept(output: InferenceOutput, attempt: Attempt, ticket: number, provider: BrainProvider): InferenceOutput {
    const unusable = malformedResponse(output, { provider: provider.name, model: provider.model });
    if (unusable !== undefined) throw unusable;
    attempt.finish(ticket, mapUsage(output.tokenUsage, output.rowResponse), this.#nowMs(), reportedModel(output));
    return output;
  }

  #timeout(attempt: Attempt, provider: BrainProvider): BrainError {
    attempt.cancel();
    return new BrainError(
      'timeout',
      `${provider.name}/${provider.model} exceeded the attempt deadline of ${String(attempt.deadlineMs)} ms`,
      {
        retryable: true,
        provider: provider.name,
        model: provider.model,
      },
    );
  }

  #malformed(provider: BrainProvider, problem: string): BrainError {
    return malformed({ provider: provider.name, model: provider.model }, problem);
  }

  #asBrainError(error: unknown, provider: BrainProvider | undefined): BrainError {
    if (error instanceof BrainError) return error;
    if (provider === undefined) return classifyProviderError(error, { provider: 'unknown', model: 'unknown' }, this.#secrets);
    return classifyProviderError(error, { provider: provider.name, model: provider.model }, this.#secrets);
  }
}
