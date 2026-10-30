/**
 * Typed failures of the stdio MCP client and how a caller reads them. Every
 * class carries a `kind` discriminator so a caller can switch on it; messages
 * and causes arrive here already redacted (see `redaction.ts`).
 */

/** The discriminator of every stdio MCP client failure. */
export type McpStdioErrorKind = 'connection' | 'timeout' | 'tool' | 'validation' | 'closed' | 'teardown';

/** Base class of every stdio MCP client failure. */
export abstract class McpStdioError extends Error {
  abstract readonly kind: McpStdioErrorKind;
}

/** The server could not be started, did not complete the handshake or dropped the connection. */
export class McpConnectionError extends McpStdioError {
  readonly kind = 'connection';
  readonly command: string;
  /** The redacted tail of the server's stderr. */
  readonly stderrTail: string;
  /** The child pid, when the process was started. */
  readonly pid: number | undefined;

  constructor(details: { command: string; reason: string; stderrTail: string; pid: number | undefined; cause?: Error }) {
    super(`MCP server "${details.command}": ${details.reason}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'McpConnectionError';
    this.command = details.command;
    this.stderrTail = details.stderrTail;
    this.pid = details.pid;
  }
}

/** A tool call did not answer within its timeout. */
export class McpTimeoutError extends McpStdioError {
  readonly kind = 'timeout';
  readonly tool: string;
  readonly timeoutMs: number;

  constructor(tool: string, timeoutMs: number) {
    super(`MCP tool "${tool}" did not answer within ${timeoutMs} ms`);
    this.name = 'McpTimeoutError';
    this.tool = tool;
    this.timeoutMs = timeoutMs;
  }
}

/** The server reported a tool failure (an error result or a protocol error). */
export class McpToolError extends McpStdioError {
  readonly kind = 'tool';
  readonly tool: string;

  constructor(tool: string, serverMessage: string) {
    super(`MCP tool "${tool}" failed: ${serverMessage}`);
    this.name = 'McpToolError';
    this.tool = tool;
  }
}

/** A tool result did not match the caller's schema. */
export class McpValidationError extends McpStdioError {
  readonly kind = 'validation';
  readonly tool: string;

  constructor(tool: string, problem: string) {
    super(`MCP tool "${tool}" returned an unexpected result: ${problem}`);
    this.name = 'McpValidationError';
    this.tool = tool;
  }
}

/** A call was made on a client that is closed. */
export class McpClosedError extends McpStdioError {
  readonly kind = 'closed';

  constructor(operation: string) {
    super(`MCP client is closed; "${operation}" was not sent`);
    this.name = 'McpClosedError';
  }
}

/** The server process was still present after the forced kill and its confirmation budget. */
export class McpTeardownError extends McpStdioError {
  readonly kind = 'teardown';
  readonly pid: number;

  constructor(pid: number, waitedMs: number) {
    super(`MCP server process ${pid} was still present ${waitedMs} ms after the close started`);
    this.name = 'McpTeardownError';
    this.pid = pid;
  }
}

/** True for a failure after which no further call on this connection can succeed. */
export function isDeadConnection(error: unknown): boolean {
  return error instanceof McpConnectionError || error instanceof McpClosedError;
}

/** The message of a caught failure, whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
