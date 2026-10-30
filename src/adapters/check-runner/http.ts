/**
 * The HTTP acceptance checks: one server per batch, started with `npm run
 * start` in the Node-only environment (no `bun` on the PATH) on a free
 * loopback port passed in `PORT`, waited for with a bounded TCP probe of
 * both loopback addresses (`127.0.0.1` and `::1`: on macOS `localhost`
 * resolves to `::1` first, so a server bound to it listens on IPv6 only),
 * and requests go to the address that answered,
 * asked one request per check, and killed with its whole process group
 * whatever the outcome. The server sees only
 * the allowlisted environment of the batch, and a request never leaves the
 * server's origin (redirects are judged as responses, never followed). The
 * body is read within the check's timeout and up to HTTP_BODY_LIMIT_BYTES;
 * a stalled or oversized body fails that check only. Invariant: no HTTP
 * check runs without a started server and no server survives the batch.
 * A directory without its own `package.json` errors every check without
 * starting anything, and `npm` is pinned to the directory with `--prefix`,
 * so it never starts an ancestor's package.
 */

import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';

import { z } from 'zod';

import type { CheckResult, ExpectedBody, HttpCheck } from '../../domain/acceptance';
import { HTTP_SERVER_START_TIMEOUT_MS } from '../../domain/limits';

import { nodeOnlyEnv } from '../node-only-env';
import { missingPackageJson, npmArgs } from '../package-guard';
import { isProcessGroupAlive, killProcessGroup, trackProcessGroup, type Batch } from './process';
import { checkResult } from './checks';

/** How often the port is probed while waiting for the server, in milliseconds. */
export const SERVER_START_POLL_MS = 100;

/**
 * How long a server that got no pid may take to report its spawn error. The
 * error always follows a failed spawn within a tick; the bound only keeps
 * the wait finite.
 */
const SPAWN_ERROR_GRACE_MS = 1_000;

/** The most body bytes one HTTP check reads; a larger body fails the check. */
export const HTTP_BODY_LIMIT_BYTES = 1_048_576;

/** One read of a body stream. */
const ReadStep = z.union([
  z.object({ done: z.literal(true), value: z.unknown() }),
  z.object({ done: z.literal(false), value: z.instanceof(Uint8Array) }),
]);

/** Reads a response body up to the limit; rejects on a stalled (aborted) read, returns `null` past the limit. */
async function boundedBody(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const step = ReadStep.parse(await reader.read());
    if (step.done) break;
    const value = step.value;
    bytes += value.byteLength;
    if (bytes > HTTP_BODY_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A free TCP port on the loopback interface, taken from a listener on port 0. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('the system gave no port'))));
    });
  });
}

/** The loopback addresses a server may listen on, in probe order. */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

/** One TCP connect attempt; true when the port accepts. */
function tryConnect(port: number, host: LoopbackHost): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Polls until the port accepts on a loopback address (returned), the start deadline passes, or the server process group dies. */
async function waitUntilListening(port: number, leaderPid: number, timeoutMs: number): Promise<LoopbackHost | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    for (const host of LOOPBACK_HOSTS) if (await tryConnect(port, host)) return host;
    if (!isProcessGroupAlive(leaderPid)) return null; // the start script exited: it will never listen
    if (performance.now() >= deadline) return null;
    await Bun.sleep(SERVER_START_POLL_MS);
  }
}

/** True for the plain objects a JSON body parses to (no arrays, no null). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep equality of two JSON values: object key order never matters. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry, index) => jsonEquals(entry, b[index]));
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEquals(a[key], b[key]));
  }
  return false;
}

/** The mismatch reason for a response body against its expectation, or null when it holds. */
export function matchBody(expected: ExpectedBody, body: string): string | null {
  if (expected.kind === 'substring') {
    return body.includes(expected.value) ? null : `body: expected substring ${JSON.stringify(expected.value)}, got ${JSON.stringify(body)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `body: expected ${expected.kind} ${JSON.stringify(expected.value)}, got non-JSON text ${JSON.stringify(body)}`;
  }
  if (expected.kind === 'exactJson') {
    return jsonEquals(parsed, expected.value)
      ? null
      : `body: expected JSON ${JSON.stringify(expected.value)}, got ${JSON.stringify(parsed)}`;
  }
  // A non-object subset expectation (an array, a primitive, null) is compared exactly.
  if (!isJsonObject(expected.value)) {
    return jsonEquals(parsed, expected.value)
      ? null
      : `body: expected JSON ${JSON.stringify(expected.value)}, got ${JSON.stringify(parsed)}`;
  }
  if (!isJsonObject(parsed)) {
    return `body: expected JSON object containing ${JSON.stringify(expected.value)}, got non-object JSON ${JSON.stringify(parsed)}`;
  }
  for (const [key, value] of Object.entries(expected.value)) {
    if (!(key in parsed) || !jsonEquals(parsed[key], value)) {
      return `body: expected JSON object containing ${JSON.stringify(key)}: ${JSON.stringify(value)}, got ${JSON.stringify(parsed)}`;
    }
  }
  return null;
}

/** Sends one check's request and judges status and body. */
async function runHttpCheck(origin: string, check: HttpCheck, secrets: readonly string[]): Promise<CheckResult> {
  const init: RequestInit = { method: check.method, signal: AbortSignal.timeout(check.timeoutMs), redirect: 'manual' };
  if (check.headers !== undefined) init.headers = check.headers;
  if (check.body !== undefined) init.body = check.body;
  const url = new URL(check.path, origin);
  if (url.origin !== origin) {
    return checkResult(check.id, 'errored', [`the path ${JSON.stringify(check.path)} leaves the server's origin`], '', secrets);
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return checkResult(check.id, 'failed', [`request failed: ${error instanceof Error ? error.message : 'unknown error'}`], '', secrets);
  }
  let body: string | null;
  try {
    body = await boundedBody(response);
  } catch (error) {
    return checkResult(check.id, 'failed', [`body read failed: ${error instanceof Error ? error.message : 'unknown error'}`], '', secrets);
  }
  if (body === null) {
    return checkResult(check.id, 'failed', [`body exceeds ${String(HTTP_BODY_LIMIT_BYTES)} bytes`], '', secrets);
  }
  const reasons: string[] = [];
  if (response.status !== check.expectedStatus) reasons.push(`expected status ${check.expectedStatus}, got ${response.status}`);
  if (check.expectedBody !== undefined) {
    const mismatch = matchBody(check.expectedBody, body);
    if (mismatch !== null) reasons.push(mismatch);
  }
  return checkResult(check.id, reasons.length === 0 ? 'passed' : 'failed', reasons, body, secrets);
}

/** Starts the server once, runs every HTTP check of the batch, stops the server. */
export async function runHttpBatch(dir: string, checks: readonly HttpCheck[], batch: Batch): Promise<readonly CheckResult[]> {
  if (checks.length === 0) return [];
  const { secrets } = batch;
  const missing = missingPackageJson(dir);
  if (missing !== null) return checks.map((check) => checkResult(check.id, 'errored', [missing], '', secrets));
  const port = await freePort();
  const child = spawn('npm', npmArgs(dir, ['run', 'start']), {
    cwd: dir,
    detached: true, // the server leads its own process group, so the stop kills its descendants too
    env: nodeOnlyEnv(batch.home, { PORT: String(port) }),
    stdio: 'ignore',
  });
  trackProcessGroup(child);
  const onAbort = (): void => killProcessGroup(child);
  batch.signal?.addEventListener('abort', onAbort, { once: true });
  // A failed spawn (missing binary, missing directory) emits 'error' instead of starting; unheard, it would crash the process.
  const spawnError = new Promise<string>((resolve) => {
    child.once('error', (error: Error) => resolve(`server spawn failed: ${error.message}`));
  });
  try {
    const pid = child.pid;
    if (pid === undefined) {
      const reason = await Promise.race([spawnError, Bun.sleep(SPAWN_ERROR_GRACE_MS).then(() => 'server spawn failed: no process id')]);
      return checks.map((check) => checkResult(check.id, 'errored', [reason], '', secrets));
    }
    const host = await waitUntilListening(port, pid, HTTP_SERVER_START_TIMEOUT_MS);
    if (host === null) {
      return checks.map((check) => checkResult(check.id, 'errored', ['server start timeout'], '', secrets));
    }
    const origin = host === '::1' ? `http://[::1]:${port}` : `http://${host}:${port}`;
    const results: CheckResult[] = [];
    for (const check of checks) results.push(await runHttpCheck(origin, check, secrets));
    return results;
  } finally {
    batch.signal?.removeEventListener('abort', onAbort);
    killProcessGroup(child);
  }
}
