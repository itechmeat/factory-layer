/**
 * The shared stdio MCP client: starts a local MCP server process, completes
 * the handshake within a deadline, calls tools with a per-call timeout,
 * validates results with Zod and always reaps the child process. It is the
 * only module that imports `@modelcontextprotocol/sdk`; the APB and OSB
 * adapters use it.
 *
 * Invariants: every wait is bounded; the child pid is recorded as soon as
 * the process starts, before the handshake, so a failed connect and a close
 * both end with the process gone; every reported text is redacted of the
 * configured secrets.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { McpClosedError, McpConnectionError, McpTimeoutError, McpToolError, McpValidationError, messageOf } from './errors';
import { terminateProcess } from './process-teardown';
import { redactSecrets, StderrTail } from './redaction';
import { parseToolPayload, toolErrorText, type ToolResult, ToolResultSchema } from './tool-result';

/** Default deadline for spawning the server and completing the handshake, in milliseconds. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** Default timeout of one tool call or tool listing request, in milliseconds. */
export const MCP_CALL_TIMEOUT_MS = 60_000;

/** Default grace period between the start of a close and SIGKILL, in milliseconds. */
export const MCP_CLOSE_GRACE_MS = 5000;

/** The client identity sent in the handshake. */
export const MCP_CLIENT_INFO = { name: 'factory-layer', version: '0.0.0' } as const;

/** The server process to start. */
export interface McpServerCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Added on top of the SDK's safe default environment (HOME, PATH, USER and the like). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Tunables of one client; every field has a default. */
export interface McpStdioOptions {
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly closeGraceMs?: number;
  /** Values replaced with `[redacted]` in every error, cause and stderr text. */
  readonly secrets?: readonly string[];
}

/** Per-call options. */
export interface McpCallOptions {
  readonly timeoutMs?: number;
}

/** A tool the server offers. */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
}

/** A connected stdio MCP client. */
export interface McpStdioClient {
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** The server process id. */
  readonly pid: number;
  /** The redacted tail of the server's stderr. */
  stderrTail(): string;
  /** Adds a secret learned after connect (a session token); redacted from then on. */
  addSecret(value: string): void;
  listTools(options?: McpCallOptions): Promise<readonly McpToolInfo[]>;
  /** The tool's result; an error result rejects with `McpToolError`. */
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<ToolResult>;
  /** The tool's structured (or JSON text) content parsed with `schema`. */
  callToolParsed<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, options?: McpCallOptions): Promise<T>;
  /** Ends the session and the process within the grace period plus 1 s; idempotent. */
  close(): Promise<void>;
}

// JSON-RPC error codes of the SDK as plain numbers, the type `McpError.code` has.
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;
const CONNECTION_CLOSED_CODE: number = ErrorCode.ConnectionClosed;

const ServerInfoSchema = z.object({ name: z.string(), version: z.string() });
const ToolListSchema = z.object({
  tools: z.array(z.looseObject({ name: z.string(), description: z.string().optional() })),
  nextCursor: z.string().optional(),
});

/** A stdio transport that reports the child pid as soon as the process has started. */
class PidReportingTransport extends StdioClientTransport {
  private readonly onStarted: (pid: number) => void;

  constructor(params: StdioServerParameters, onStarted: (pid: number) => void) {
    super(params);
    this.onStarted = onStarted;
  }

  override async start(): Promise<void> {
    await super.start();
    if (this.pid !== null) this.onStarted(this.pid);
  }
}

function serverParameters(server: McpServerCommand): StdioServerParameters {
  return {
    command: server.command,
    args: [...(server.args ?? [])],
    stderr: 'pipe',
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    ...(server.env === undefined ? {} : { env: { ...server.env } }),
  };
}

/** Lets stderr chunks already read from the pipe reach the tail. */
function drainPendingIo(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

class ConnectedClient implements McpStdioClient {
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly pid: number;
  private closing: Promise<void> | undefined;
  private readonly sdk: Client;
  private readonly server: McpServerCommand;
  private readonly tail: StderrTail;
  private readonly settings: Required<McpStdioOptions>;
  private readonly secrets: string[];

  constructor(parts: {
    sdk: Client;
    server: McpServerCommand;
    tail: StderrTail;
    settings: Required<McpStdioOptions>;
    pid: number;
    serverInfo: { name: string; version: string };
  }) {
    this.sdk = parts.sdk;
    this.server = parts.server;
    this.tail = parts.tail;
    this.settings = parts.settings;
    this.secrets = [...parts.settings.secrets];
    this.pid = parts.pid;
    this.serverInfo = parts.serverInfo;
  }

  stderrTail(): string {
    return this.tail.text();
  }

  addSecret(value: string): void {
    this.secrets.push(value);
    this.tail.addSecret(value);
  }

  async listTools(options: McpCallOptions = {}): Promise<readonly McpToolInfo[]> {
    const timeoutMs = options.timeoutMs ?? this.settings.callTimeoutMs;
    const deadline = performance.now() + timeoutMs;
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const left = Math.ceil(deadline - performance.now());
      // No page is requested once the listing's budget is spent.
      if (left <= 0) throw new McpTimeoutError('tools/list', timeoutMs);
      const page = this.validate(
        'tools/list',
        ToolListSchema,
        await this.guard('tools/list', timeoutMs, () => this.sdk.listTools(cursor === undefined ? {} : { cursor }, { timeout: left })),
      );
      tools.push(...page.tools.map((tool) => ({ name: tool.name, description: tool.description })));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<ToolResult> {
    const timeout = options.timeoutMs ?? this.settings.callTimeoutMs;
    const raw = await this.guard(name, timeout, () => this.sdk.callTool({ name, arguments: args }, undefined, { timeout }));
    const result = this.validate(name, ToolResultSchema, raw);
    if (result.isError === true) throw new McpToolError(name, this.redact(toolErrorText(result)));
    return result;
  }

  async callToolParsed<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, options: McpCallOptions = {}): Promise<T> {
    return parseToolPayload(name, await this.callTool(name, args, options), schema, this.secrets);
  }

  close(): Promise<void> {
    this.closing ??= terminateProcess({
      pid: this.pid,
      graceMs: this.settings.closeGraceMs,
      close: () => this.sdk.close(),
    });
    return this.closing;
  }

  private redact(text: string): string {
    return redactSecrets(text, this.secrets);
  }

  /** `raw` parsed with `schema`, or a redacted validation error naming `operation`. */
  private validate<T>(operation: string, schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new McpValidationError(operation, this.redact(z.prettifyError(parsed.error)));
    return parsed.data;
  }

  /** Runs one request and turns its failure into a typed, redacted error. */
  private async guard<T>(operation: string, timeoutMs: number, send: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) throw new McpClosedError(operation);
    try {
      return await send();
    } catch (error) {
      if (this.closing !== undefined) throw new McpClosedError(operation);
      if (error instanceof McpError && error.code === REQUEST_TIMEOUT_CODE) {
        throw new McpTimeoutError(operation, timeoutMs);
      }
      // The SDK rejects with the Zod error when a result breaks the MCP
      // schema; the connection itself is fine.
      if (error instanceof z.core.$ZodError) {
        throw new McpValidationError(operation, this.redact(z.prettifyError(error)));
      }
      if (error instanceof McpError && error.code !== CONNECTION_CLOSED_CODE) {
        throw new McpToolError(operation, this.redact(error.message));
      }
      await drainPendingIo();
      throw new McpConnectionError({
        command: this.server.command,
        reason: `connection lost during "${operation}": ${this.redact(messageOf(error))}`,
        stderrTail: this.tail.text(),
        pid: this.pid,
      });
    }
  }
}

/**
 * Starts `server` and completes the MCP handshake within the connect
 * deadline. On any failure the process is terminated before the returned
 * promise rejects with a `McpConnectionError`.
 */
export async function connectMcpStdio(server: McpServerCommand, options: McpStdioOptions = {}): Promise<McpStdioClient> {
  const settings: Required<McpStdioOptions> = {
    connectTimeoutMs: options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
    closeGraceMs: options.closeGraceMs ?? MCP_CLOSE_GRACE_MS,
    secrets: options.secrets ?? [],
  };
  const tail = new StderrTail(settings.secrets);
  let pid: number | undefined;
  const transport = new PidReportingTransport(serverParameters(server), (started) => {
    pid = started;
  });
  const decoder = new TextDecoder();
  transport.stderr?.on('data', (chunk: Uint8Array) => tail.append(decoder.decode(chunk, { stream: true })));
  const sdk = new Client(MCP_CLIENT_INFO, { capabilities: {} });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), settings.connectTimeoutMs);
  });
  let failure: string;
  let cause: unknown;
  try {
    const outcome = await Promise.race([sdk.connect(transport).then(() => 'connected' as const), deadline]);
    if (outcome === 'connected') {
      if (pid === undefined) throw new Error('the transport started without a process id');
      const serverInfo = ServerInfoSchema.parse(sdk.getServerVersion());
      return new ConnectedClient({ sdk, server, tail, settings, pid, serverInfo });
    }
    failure = `did not complete the handshake within ${settings.connectTimeoutMs} ms`;
  } catch (error) {
    cause = error;
    failure = `could not connect: ${messageOf(error)}`;
  } finally {
    clearTimeout(timer);
  }

  let teardown = '';
  if (pid !== undefined) {
    await terminateProcess({ pid, graceMs: settings.closeGraceMs, close: () => sdk.close() }).catch((error: unknown) => {
      teardown = `; ${messageOf(error)}`;
    });
  }
  await drainPendingIo();
  const redact = (text: string): string => redactSecrets(text, settings.secrets);
  throw new McpConnectionError({
    command: server.command,
    reason: redact(failure + teardown),
    stderrTail: tail.text(),
    pid,
    ...(cause === undefined ? {} : { cause: new Error(redact(messageOf(cause))) }),
  });
}
