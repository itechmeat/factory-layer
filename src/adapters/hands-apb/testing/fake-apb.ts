/**
 * A scripted fake of the `apb mcp` tool surface for the unit tests of the
 * APB adapter. It behaves like the stdio MCP client where that matters:
 * a call that outlives its `timeoutMs` rejects with `McpTimeoutError`, a
 * result that does not match the caller's schema rejects with
 * `McpValidationError`, and every call is recorded with its start time and
 * the secrets registered before it.
 */

import type { z } from 'zod';

import { McpTimeoutError, McpToolError, McpValidationError } from '../../mcp-stdio/errors';
import type { ApbToolCaller } from '../apb-tool-caller';

/** Answers one tool call; may be slow, may throw. */
export type FakeHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** One recorded call. */
export interface FakeCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly timeoutMs: number | undefined;
  /** Milliseconds since the fake was created. */
  readonly at: number;
  /** The secrets registered when the call was made. */
  readonly secrets: readonly string[];
}

/** Resolves with `value` after `ms`. */
export function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

/** A promise that never settles: a server that does not answer. */
export function never(): Promise<never> {
  return new Promise<never>(() => {});
}

/** Answers with each value in turn, repeating the last one. */
export function sequence(...answers: readonly unknown[]): FakeHandler {
  let index = 0;
  return async () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return answer;
  };
}

function withTimeout<T>(work: Promise<T>, name: string, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError(name, timeoutMs)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The fake tool caller. */
export class FakeApb implements ApbToolCaller {
  readonly calls: FakeCall[] = [];
  readonly secrets: string[] = [];
  closed = false;
  private readonly handlers: Readonly<Record<string, FakeHandler>>;
  private readonly createdAt = performance.now();

  constructor(handlers: Readonly<Record<string, FakeHandler>>) {
    this.handlers = handlers;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  addSecret(value: string): void {
    this.secrets.push(value);
  }

  /** The calls made to one tool. */
  callsTo(name: string): FakeCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  async callToolParsed<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<T> {
    this.calls.push({ name, args, timeoutMs: options.timeoutMs, at: performance.now() - this.createdAt, secrets: [...this.secrets] });
    const handler = this.handlers[name];
    if (handler === undefined) throw new McpToolError(name, `the fake has no handler for ${name}`);
    const raw = await withTimeout(handler(args), name, options.timeoutMs);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new McpValidationError(name, parsed.error.message);
    return parsed.data;
  }
}
