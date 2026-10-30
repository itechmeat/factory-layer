/**
 * The guarded inference runner: Mozaik's `InferenceRunner` over a table of
 * OpenAI-compatible providers. It replaces Mozaik's default runner and keeps
 * its request checks, and adds what the factory's loop contract needs: every
 * call belongs to an attempt bound by its `ModelContext`, with one absolute
 * deadline and a cancellation flag; failures are typed and redacted;
 * responses are validated and their usage recorded on the attempt.
 *
 * Invariants: no inference reaches a provider unless its context is bound to
 * a live attempt and the request passes the checks; a timeout cancels its
 * attempt; valid output is returned to Mozaik unchanged.
 */

import type { Endpoint, InferenceInput, InferenceOutput, InferenceRunner, ModelContext, SemanticEvent } from '@mozaik-ai/core';
import { z } from 'zod';

import type { Clock } from '../../ports/index';
import { Attempt } from './attempt';
import { raceDeadline } from './deadline';
import { BrainError, classifyProviderError } from './errors';
import { findRequestViolation, type ModelCapabilities } from './request-checks';
import { malformed, malformedResponse, mapUsage } from './response';

/** Default attempt budget, milliseconds from bind time. */
export const BRAIN_ATTEMPT_DEADLINE_MS = 90_000;
/** Longest wait for a provider stream to close after the consumer stopped early, milliseconds. */
export const STREAM_CLEANUP_MS = 1_000;

/** One configured model: the endpoint that serves it and what it accepts. */
export interface BrainProvider {
  readonly name: string;
  readonly model: string;
  readonly endpoint: Endpoint;
  readonly capabilities: ModelCapabilities;
}

/** What the runner needs: the provider table, a clock, and the secrets to keep out of errors. */
export interface GuardedRunnerOptions {
  readonly providers: readonly BrainProvider[];
  readonly clock: Clock;
  readonly secrets: readonly string[];
}

/** The shape of the final event payload of a stream. */
const OutputPayload = z.custom<InferenceOutput>(
  (value) => z.object({ items: z.array(z.unknown()), rowResponse: z.unknown() }).safeParse(value).success,
);

export class GuardedInferenceRunner implements InferenceRunner {
  readonly #providers = new Map<string, BrainProvider>();
  readonly #attempts = new WeakMap<ModelContext, Attempt>();
  readonly #clock: Clock;
  readonly #secrets: readonly string[];

  constructor(options: GuardedRunnerOptions) {
    for (const provider of options.providers) {
      if (this.#providers.has(provider.model))
        throw new Error(`Two providers serve the model "${provider.model}"; model names must be unique`);
      this.#providers.set(provider.model, provider);
    }
    this.#clock = options.clock;
    this.#secrets = options.secrets;
  }

  /** Binds a context to a new attempt whose deadline starts now. One context, one attempt. */
  bind(context: ModelContext, options: { readonly deadlineMs?: number } = {}): Attempt {
    if (this.#attempts.has(context)) throw new Error(`Context ${context.id} is already bound to an attempt`);
    const attempt = new Attempt(options.deadlineMs ?? BRAIN_ATTEMPT_DEADLINE_MS, this.#nowMs());
    this.#attempts.set(context, attempt);
    return attempt;
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const { attempt, provider } = this.#admit(input);
    const startedMs = this.#nowMs();
    try {
      const output = await raceDeadline(provider.endpoint.infer(input), attempt.timeLeftMs(startedMs), () =>
        this.#timeout(attempt, provider),
      );
      this.#assertInTime(attempt, provider);
      return this.#accept(output, attempt, provider, startedMs);
    } catch (error) {
      throw this.#asBrainError(error, provider);
    }
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    const { attempt, provider } = this.#admit(input);
    const startedMs = this.#nowMs();
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
          output = this.#accept(payload.data, attempt, provider, startedMs);
        }
        yield step.value;
      }
    } catch (error) {
      this.#closeInBackground(events);
      exhausted = true;
      throw this.#asBrainError(error, provider);
    } finally {
      // Reached without `exhausted` only when the consumer stopped early (`break` or `return()`).
      if (!exhausted) await this.#close(events);
    }
    if (output === undefined) throw this.#malformed(provider, 'a stream that ended without an output');
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
  #accept(output: InferenceOutput, attempt: Attempt, provider: BrainProvider, startedMs: number): InferenceOutput {
    const unusable = malformedResponse(output, { provider: provider.name, model: provider.model });
    if (unusable !== undefined) throw unusable;
    attempt.record({
      provider: provider.name,
      model: provider.model,
      elapsedMs: this.#nowMs() - startedMs,
      usage: mapUsage(output.tokenUsage),
    });
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

  #asBrainError(error: unknown, provider: BrainProvider): BrainError {
    if (error instanceof BrainError) return error;
    return classifyProviderError(error, { provider: provider.name, model: provider.model }, this.#secrets);
  }
}
