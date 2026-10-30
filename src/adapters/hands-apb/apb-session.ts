/**
 * The executor's one `apb mcp` connection, replaced once when it dies. A call
 * that finds the connection dead (the process exited, the pipe closed)
 * starts a new connection, lets the executor re-attach its runs on it, and,
 * for a call that is safe to repeat (a read or a wait), runs the call again
 * there. A connection that dies a second time is not replaced: every later
 * call fails with `ApbConnectionLostError`, the port's `failed` reason marked
 * as a lost connection so the executor can tell it from APB declining a
 * call. Every other failure is mapped to the port's `ExecutorError` by
 * `executorErrorOf`.
 */

import { isDeadConnection, McpTimeoutError, McpToolError, McpValidationError, messageOf } from '../mcp-stdio/errors';
import type { ApbToolCaller } from './apb-tool-caller';
import { ExecutorError } from '../../ports/executor';

/** The `apb mcp` connection is gone for good: the port's `failed`, distinguishable by class. */
export class ApbConnectionLostError extends ExecutorError {
  constructor(detail: string) {
    super({ reason: 'failed', detail: `connection lost: ${detail}` });
    this.name = 'ApbConnectionLostError';
  }
}

/** A connection the session can close. */
export interface ApbConnection extends ApbToolCaller {
  close(): Promise<void>;
}

/** The executor's typed error for a failed call of `tool`. */
export function executorErrorOf(tool: string, error: unknown): ExecutorError {
  if (error instanceof ExecutorError) return error;
  const detail = `${tool}: ${messageOf(error)}`;
  if (isDeadConnection(error)) return new ApbConnectionLostError(detail);
  if (error instanceof McpTimeoutError) return new ExecutorError({ reason: 'timeout', detail });
  if (error instanceof McpValidationError) return new ExecutorError({ reason: 'protocol', detail });
  if (error instanceof McpToolError) return new ExecutorError({ reason: 'failed', detail });
  return new ExecutorError({ reason: 'failed', detail });
}

/** One connection with a single replacement. */
export class ApbSession {
  private readonly connect: () => Promise<ApbConnection>;
  private readonly onReconnect: (caller: ApbToolCaller) => Promise<void>;
  private connection: Promise<ApbConnection> | undefined;
  /** Counts connections; a failure on an older one needs no new replacement. */
  private current = 0;
  private replacing: Promise<void> | undefined;
  private lost: string | undefined;

  /** `onReconnect` re-attaches the executor's runs on the new connection before any retried call. */
  constructor(connect: () => Promise<ApbConnection>, onReconnect: (caller: ApbToolCaller) => Promise<void>) {
    this.connect = connect;
    this.onReconnect = onReconnect;
  }

  /** Which connection is in use; pass it to `replaceAfter` when a call on it found it dead. */
  get generation(): number {
    return this.current;
  }

  /** The live connection, connecting on first use. */
  async caller(): Promise<ApbToolCaller> {
    if (this.lost !== undefined) throw new ApbConnectionLostError(this.lost);
    this.connection ??= this.connect();
    return this.connection;
  }

  /**
   * Runs `work` on the connection. When it fails on a dead connection, the
   * connection is replaced once; `work` runs again on the new one only when
   * `repeatable`, otherwise the original failure is rethrown for the caller
   * to judge (a start whose answer is lost is indeterminate, not repeated).
   */
  async run<T>(work: (caller: ApbToolCaller) => Promise<T>, repeatable: boolean): Promise<T> {
    const used = this.current;
    try {
      return await work(await this.caller());
    } catch (error) {
      if (!isDeadConnection(error)) throw error;
      await this.replaceAfter(used, messageOf(error));
      if (!repeatable) throw error;
      return work(await this.caller());
    }
  }

  /**
   * Replaces connection `used`, which was found dead. Concurrent callers that
   * found the same connection dead share one replacement; a connection that
   * was already a replacement is not replaced again and the session is lost.
   */
  async replaceAfter(used: number, reason: string): Promise<void> {
    if (used < this.current) {
      await this.replacing;
      return;
    }
    if (this.lost !== undefined) throw new ApbConnectionLostError(this.lost);
    if (this.current >= 1) {
      this.lost = `the apb mcp connection died again after one replacement: ${reason}`;
      throw new ApbConnectionLostError(this.lost);
    }
    this.current += 1;
    this.replacing = this.reconnect();
    try {
      await this.replacing;
    } finally {
      this.replacing = undefined;
    }
  }

  private async reconnect(): Promise<void> {
    const dead = this.connection;
    this.connection = undefined;
    await dead?.then((connection) => connection.close()).catch(() => undefined);
    try {
      await this.onReconnect(await this.caller());
    } catch (error) {
      this.lost = `the apb mcp connection could not be replaced: ${messageOf(error)}`;
      throw new ApbConnectionLostError(this.lost);
    }
  }

  /** Closes the connection; the session cannot be used afterwards. */
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.lost = 'the executor is closed';
    // A connection that never came up has nothing to close.
    await connection?.then(
      (live) => live.close(),
      () => undefined,
    );
  }
}
