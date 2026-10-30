import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { connectMcpStdio, type McpStdioClient, type McpStdioOptions } from './client';
import { McpClosedError, McpConnectionError, McpTimeoutError, McpToolError, McpValidationError } from './errors';
import { isProcessAlive } from './process-teardown';

const FIXTURE = join(import.meta.dir, '../../../tests/fixtures/fake-mcp-server.ts');
const SECRET = 'sk-test-0123456789';

const open: McpStdioClient[] = [];

function fakeServer(...flags: string[]) {
  return { command: process.execPath, args: [FIXTURE, ...flags] };
}

async function connect(flags: string[] = [], options: McpStdioOptions = {}): Promise<McpStdioClient> {
  const client = await connectMcpStdio(fakeServer(...flags), options);
  open.push(client);
  return client;
}

async function connectError(flags: string[], options: McpStdioOptions): Promise<McpConnectionError> {
  const error: unknown = await connectMcpStdio(fakeServer(...flags), options).catch((caught: unknown) => caught);
  if (!(error instanceof McpConnectionError)) throw new Error(`expected a connection error, got ${String(error)}`);
  return error;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

describe('connect', () => {
  test('a server that never answers fails at the connect deadline and is gone', async () => {
    const started = performance.now();
    const error = await connectError(['--mode', 'silent'], { connectTimeoutMs: 300, closeGraceMs: 500 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(error.kind).toBe('connection');
    expect(error.message).toContain(process.execPath);
    expect(error.message).toContain('300 ms');
    expect(error.stderrTail).toContain('fake server mode silent');
    expect(error.pid).toBeDefined();
    expect(isProcessAlive(error.pid ?? 0)).toBe(false);
  });

  test('an invalid handshake from an uncooperative server ends with the process gone in about 1.5 s', async () => {
    const started = performance.now();
    const error = await connectError(['--mode', 'invalid-handshake', '--stubborn'], { closeGraceMs: 500 });
    expect(performance.now() - started).toBeLessThan(1800);
    expect(error.kind).toBe('connection');
    expect(isProcessAlive(error.pid ?? 0)).toBe(false);
  });

  test('a server that exits before the handshake yields its stderr tail', async () => {
    const error = await connectError(['--mode', 'exit-early'], { closeGraceMs: 500 });
    expect(error.stderrTail).toContain('fake server gives up');
    expect(isProcessAlive(error.pid ?? 0)).toBe(false);
  });

  test('the server process gets the command working directory and environment', async () => {
    const cwd = tmpdir();
    const client = await connectMcpStdio({ ...fakeServer(), cwd, env: { APB_EXECUTION: 'cli' } }, {});
    open.push(client);
    const seen = await client.callToolParsed('env', { name: 'APB_EXECUTION' }, z.object({ cwd: z.string(), value: z.string().nullable() }));
    expect(realpathSync(seen.cwd)).toBe(realpathSync(cwd));
    expect(seen.value).toBe('cli');
  });

  test('a command that cannot be spawned names the command', async () => {
    const error: unknown = await connectMcpStdio({ command: 'factory-no-such-binary-xyz' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpConnectionError);
    expect(String(error)).toContain('factory-no-such-binary-xyz');
  });
});

describe('tool calls', () => {
  test('stops paging at the listing deadline instead of paging forever', async () => {
    const client = await connect(['--paginate-forever']);
    const started = performance.now();
    const error: unknown = await client.listTools({ timeoutMs: 300 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpTimeoutError);
    expect(error).toMatchObject({ kind: 'timeout', tool: 'tools/list', timeoutMs: 300 });
    expect(performance.now() - started).toBeLessThan(450);
  });

  test('a result that breaks the MCP schema is a validation error and the connection stays usable', async () => {
    const client = await connect();
    const error: unknown = await client.callTool('bad-envelope', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpValidationError);
    expect(error).toMatchObject({ kind: 'validation', tool: 'bad-envelope' });
    expect((await client.callTool('echo', { text: 'still here' })).structuredContent).toEqual({ text: 'still here' });
  });

  test('rejects a mismatching result with a validation error naming the tool', async () => {
    const client = await connect();
    const call = client.callToolParsed('echo', { text: 'hi' }, z.object({ text: z.number() }));
    await expect(call).rejects.toBeInstanceOf(McpValidationError);
    await expect(call).rejects.toThrow(/echo/);
  });

  test('a slow tool rejects with a timeout error naming the tool and the timeout', async () => {
    const client = await connect();
    const error: unknown = await client.callTool('slow', {}, { timeoutMs: 200 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpTimeoutError);
    expect(error).toMatchObject({ kind: 'timeout', tool: 'slow', timeoutMs: 200 });
    expect(String(error)).toContain('200 ms');
  });

  test('an error result rejects with a tool error carrying the server message', async () => {
    const client = await connect();
    const call = client.callTool('fail', {});
    await expect(call).rejects.toBeInstanceOf(McpToolError);
    await expect(call).rejects.toThrow('tool failed');
  });

  test('a protocol error for an unknown tool is a tool error', async () => {
    const client = await connect();
    const call = client.callTool('nope', {});
    await expect(call).rejects.toBeInstanceOf(McpToolError);
    await expect(call).rejects.toThrow(/unknown tool nope/);
  });

  test('a JSON-RPC error with a data code rejects with a tool error carrying that code', async () => {
    const client = await connect();
    const error: unknown = await client.callTool('coded-fail', { code: 'exists' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolError);
    expect(error).toMatchObject({ kind: 'tool', tool: 'coded-fail', code: 'exists' });
  });

  test('an error without a data code leaves the code undefined', async () => {
    const client = await connect();
    const error: unknown = await client.callTool('nope', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolError);
    expect(error).toMatchObject({ kind: 'tool', code: undefined });
  });

  test('a server that dies during a call yields a connection error with its stderr tail', async () => {
    const client = await connect();
    const error: unknown = await client.callTool('crash', {}).catch((caught: unknown) => caught);
    if (!(error instanceof McpConnectionError)) throw new Error(`expected a connection error, got ${String(error)}`);
    expect(error.pid).toBe(client.pid);
    expect(error.stderrTail).toContain('fake server crashed');
  });

  test('a call after close rejects with a closed error', async () => {
    const client = await connect();
    await client.close();
    await expect(client.callTool('echo', {})).rejects.toBeInstanceOf(McpClosedError);
    await expect(client.listTools()).rejects.toBeInstanceOf(McpClosedError);
  });
});

describe('close', () => {
  test('stops a cooperative server and is idempotent', async () => {
    const client = await connectMcpStdio(fakeServer());
    await client.close();
    expect(isProcessAlive(client.pid)).toBe(false);
    await client.close();
  });

  test('kills an uncooperative server within the grace period plus about 1 s', async () => {
    const client = await connectMcpStdio(fakeServer('--stubborn'), { closeGraceMs: 500 });
    const started = performance.now();
    await client.close();
    const elapsed = performance.now() - started;
    expect(isProcessAlive(client.pid)).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(490);
    expect(elapsed).toBeLessThan(1600);
  });
});

describe('abort signal', () => {
  test('an abort during the handshake fails the connect at once and the process is gone', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const error = await connectError(['--mode', 'silent'], { connectTimeoutMs: 10_000, closeGraceMs: 500, signal: controller.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(error.message).toContain('aborted');
    expect(isProcessAlive(error.pid ?? 0)).toBe(false);
  });

  test('an abort after the connect closes the client: the pending call ends and the process is gone', async () => {
    const controller = new AbortController();
    const client = await connect([], { closeGraceMs: 500, signal: controller.signal });
    const pending = client.callTool('slow', {}, { timeoutMs: 10_000 }).catch((caught: unknown) => caught);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toBeInstanceOf(McpClosedError);
    await client.close();
    expect(isProcessAlive(client.pid)).toBe(false);
  });
});

describe('redaction', () => {
  test('a leaked secret is absent from the tool error and the stderr tail', async () => {
    const client = await connect(['--secret', SECRET], { secrets: [SECRET] });
    const error: unknown = await client.callTool('fail', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolError);
    expect(String(error)).toContain('[redacted]');
    expect(String(error)).not.toContain(SECRET);
    expect(client.stderrTail()).toContain('[redacted]');
    expect(client.stderrTail()).not.toContain(SECRET);
  });

  test('a leaked secret is absent from the code and the message of a coded tool error', async () => {
    const client = await connect(['--secret', SECRET], { secrets: [SECRET] });
    const error: unknown = await client.callTool('coded-fail', { code: `bad-${SECRET}` }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'bad-[redacted]' });
    expect(String(error)).toContain('[redacted]');
    expect(String(error)).not.toContain(SECRET);
  });

  test('a secret added after connect is redacted from tool errors and the stderr tail', async () => {
    const client = await connect(['--secret', SECRET]);
    client.addSecret(SECRET);
    const error: unknown = await client.callTool('fail', {}).catch((caught: unknown) => caught);
    expect(String(error)).toContain('[redacted]');
    expect(String(error)).not.toContain(SECRET);
    expect(client.stderrTail()).not.toContain(SECRET);
  });

  test('a leaked secret is absent from a connection error and its stderr tail', async () => {
    const error = await connectError(['--mode', 'exit-early', '--secret', SECRET], { secrets: [SECRET] });
    expect(error.stderrTail).toContain('[redacted]');
    expect(`${error.message}${error.stderrTail}${String(error.cause)}`).not.toContain(SECRET);
  });
});
