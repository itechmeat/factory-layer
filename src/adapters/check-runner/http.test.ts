import { afterAll, describe, expect, test } from 'bun:test';

import { AcceptanceCheckSchema, type AcceptanceCheck, type HttpCheck } from '../../domain/acceptance';
import { ProcessCheckRunner } from './check-runner';
import { matchBody } from './http';
import { cleanupFixturePackages, fixturePackage } from './testing/fixture-package';
import { pgrepCount, waitFor } from './testing/process-count';

afterAll(cleanupFixturePackages);

const SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT);
http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'hello' }));
    } else if (url.pathname === '/text') {
      response.end('plain body here');
    } else if (url.pathname === '/echo') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(Number(url.searchParams.get('status') ?? '200'));
        response.end(Buffer.concat(chunks).toString() + ':' + (request.headers['x-echo'] ?? ''));
      });
    } else if (url.pathname === '/redirect') {
      response.writeHead(302, { location: 'http://example.com/elsewhere' });
      response.end();
    } else if (url.pathname === '/stall') {
      response.write('partial');
    } else if (url.pathname === '/huge') {
      response.end('y'.repeat(3_000_000) + 'END');
    } else if (url.pathname === '/slow') {
      setTimeout(() => response.end('late'), 5000);
    } else {
      response.writeHead(404);
      response.end('not found');
    }
  })
  .listen(port, '127.0.0.1');
`;

/** Writes a server fixture; `start` replaces the start script. */
async function fixtureServer(start = 'node server.js'): Promise<{ dir: string; marker: string }> {
  const marker = `fcr-server-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const dir = await fixturePackage({
    'package.json': JSON.stringify({ name: 'http-fixture', private: true, scripts: { start: `${start} ${marker}` } }),
    'server.js': SERVER_JS,
  });
  return { dir, marker };
}

/** Parses an HTTP check through the boundary schema, so the type defaults apply. */
function httpCheck(input: Record<string, unknown>): AcceptanceCheck {
  return AcceptanceCheckSchema.parse({
    kind: 'http',
    description: 'http',
    method: 'GET',
    path: '/json',
    expectedStatus: 200,
    timeoutMs: 3000,
    ...input,
  });
}

/** The joined reason lines of a result, for assertions. */
function reasonOf(result: { reasons: readonly string[] }): string {
  return result.reasons.join(' ');
}

describe('ProcessCheckRunner.runChecks, HTTP batch', () => {
  test('a path that resolves to another origin errors without a request', async () => {
    const { dir } = await fixtureServer();
    // Not parsed on purpose: the runner itself keeps every request on the server's origin.
    const escaping: HttpCheck = {
      kind: 'http',
      id: 'http-escape',
      description: 'escapes',
      method: 'GET',
      path: '/\\example.com/x',
      expectedStatus: 200,
      timeoutMs: 3000,
    };
    const [result] = await new ProcessCheckRunner().runChecks(dir, [escaping]);
    expect(result?.status).toBe('errored');
    expect(reasonOf(result ?? { reasons: [] })).toContain("leaves the server's origin");
  });

  test('a matching status and exactJson body pass', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-ok', expectedBody: { kind: 'exactJson', value: { message: 'hello' } } }),
    ]);
    expect(result?.status).toBe('passed');
    expect(result?.reasons).toEqual([]);
  });

  test('a wrong status fails naming expected and actual', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [httpCheck({ id: 'http-status', expectedStatus: 404 })]);
    expect(result?.status).toBe('failed');
    const reason = reasonOf(result ?? { reasons: [] });
    expect(reason).toContain('expected status 404');
    expect(reason).toContain('got 200');
  });

  test('an exactJson mismatch is named with expected and actual', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-json', expectedBody: { kind: 'exactJson', value: { message: 'bye' } } }),
    ]);
    expect(result?.status).toBe('failed');
    const reason = reasonOf(result ?? { reasons: [] });
    expect(reason).toContain('"bye"');
    expect(reason).toContain('"hello"');
  });

  test('jsonSubset passes when every expected key deep-equals and fails when one differs', async () => {
    const { dir } = await fixtureServer();
    const runner = new ProcessCheckRunner();
    const [passing] = await runner.runChecks(dir, [
      httpCheck({ id: 'http-subset-ok', expectedBody: { kind: 'jsonSubset', value: { message: 'hello' } } }),
    ]);
    expect(passing?.status).toBe('passed');

    const [failing] = await runner.runChecks(dir, [
      httpCheck({ id: 'http-subset-bad', expectedBody: { kind: 'jsonSubset', value: { message: 'hello', extra: 1 } } }),
    ]);
    expect(failing?.status).toBe('failed');
    expect(reasonOf(failing ?? { reasons: [] })).toContain('extra');
  });

  test('a substring body matches, and a miss is named with expected and actual', async () => {
    const { dir } = await fixtureServer();
    const runner = new ProcessCheckRunner();
    const [passing] = await runner.runChecks(dir, [
      httpCheck({ id: 'http-sub-ok', path: '/text', expectedBody: { kind: 'substring', value: 'plain body' } }),
    ]);
    expect(passing?.status).toBe('passed');

    const [failing] = await runner.runChecks(dir, [
      httpCheck({ id: 'http-sub-bad', path: '/text', expectedBody: { kind: 'substring', value: 'absent text' } }),
    ]);
    expect(failing?.status).toBe('failed');
    const reason = reasonOf(failing ?? { reasons: [] });
    expect(reason).toContain('absent text');
    expect(reason).toContain('plain body here');
  });

  test('a non-JSON body when JSON is expected fails without throwing', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-nonjson', path: '/text', expectedBody: { kind: 'exactJson', value: { a: 1 } } }),
    ]);
    expect(result?.status).toBe('failed');
    expect(reasonOf(result ?? { reasons: [] })).toContain('non-JSON');
  });

  test('headers and request body reach the server', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({
        id: 'http-echo',
        description: 'echoes method, headers and body',
        method: 'POST',
        path: '/echo?status=201',
        headers: { 'x-echo': 'h1', 'content-type': 'text/plain' },
        body: 'echo-body',
        expectedStatus: 201,
        expectedBody: { kind: 'substring', value: 'echo-body:h1' },
      }),
    ]);
    expect(result?.status).toBe('passed');
  });

  test('a server that never listens errors every check with the start timeout, fast', async () => {
    const { dir, marker } = await fixtureServer('exit 0');
    const started = performance.now();
    const results = await new ProcessCheckRunner().runChecks(dir, [httpCheck({ id: 'http-dead-1' }), httpCheck({ id: 'http-dead-2' })]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(results.map((result) => result.status)).toEqual(['errored', 'errored']);
    for (const result of results) expect(result.reasons).toContain('server start timeout');
    await waitFor(async () => (await pgrepCount(marker)) === 0);
  });

  test('a Bun-only start script fails every check of the batch with the start reason', async () => {
    const { dir, marker } = await fixtureServer('bun server.js');
    const results = await new ProcessCheckRunner().runChecks(dir, [httpCheck({ id: 'http-bun-1' }), httpCheck({ id: 'http-bun-2' })]);
    expect(results.map((result) => result.status)).toEqual(['errored', 'errored']);
    for (const result of results) expect(result.reasons).toContain('server start timeout');
    await waitFor(async () => (await pgrepCount(marker)) === 0);
  });

  test('a server that cannot be spawned errors every check with the spawn failure instead of crashing', async () => {
    const results = await new ProcessCheckRunner().runChecks('/nonexistent-fcr-http-dir', [
      httpCheck({ id: 'http-nospawn-1' }),
      httpCheck({ id: 'http-nospawn-2' }),
    ]);
    // A tick later the uncaught spawn error would have crashed the test process.
    await Bun.sleep(50);
    expect(results.map((result) => result.status)).toEqual(['errored', 'errored']);
    for (const result of results) expect(reasonOf(result)).toContain('server spawn failed');
  });

  test('the server and its group are stopped after the batch whatever the outcome', async () => {
    const { dir, marker } = await fixtureServer();
    const results = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-stop-pass' }),
      httpCheck({ id: 'http-stop-fail', expectedStatus: 500 }),
    ]);
    expect(results).toHaveLength(2);
    await waitFor(async () => (await pgrepCount(marker)) === 0);
  });

  test('a mixed batch returns one result per check in input order', async () => {
    const { dir } = await fixtureServer();
    const results = await new ProcessCheckRunner().runChecks(dir, [
      AcceptanceCheckSchema.parse({ id: 'mixed-cmd', description: 'shell', kind: 'command', command: 'exit 0', expectedExitCode: 0 }),
      httpCheck({ id: 'mixed-http', expectedBody: { kind: 'exactJson', value: { message: 'hello' } } }),
      httpCheck({ id: 'mixed-http-2', expectedStatus: 500 }),
    ]);
    expect(results.map((result) => result.checkId)).toEqual(['mixed-cmd', 'mixed-http', 'mixed-http-2']);
    expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'failed']);
  });

  test('a request that cannot reach the server fails as request failed', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-timeout', path: '/slow', timeoutMs: 200, expectedStatus: 200 }),
    ]);
    expect(result?.status).toBe('failed');
    expect(reasonOf(result ?? { reasons: [] })).toContain('request failed');
  });

  test('a redirect is judged as the 3xx it is, never followed', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-redirect', path: '/redirect', expectedStatus: 302 }),
    ]);
    expect(result?.status).toBe('passed');
  });

  test('a body that stalls after the headers fails that check only', async () => {
    const { dir } = await fixtureServer();
    const results = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-stall', path: '/stall', timeoutMs: 300 }),
      httpCheck({ id: 'http-after', expectedBody: { kind: 'exactJson', value: { message: 'hello' } } }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['failed', 'passed']);
    expect(reasonOf(results[0] ?? { reasons: [] })).toContain('body');
  });

  test('a body past the read bound fails without holding it all', async () => {
    const { dir } = await fixtureServer();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      httpCheck({ id: 'http-huge', path: '/huge', expectedBody: { kind: 'substring', value: 'END' } }),
    ]);
    expect(result?.status).toBe('failed');
    expect(reasonOf(result ?? { reasons: [] })).toContain('exceeds');
  });
});

describe('matchBody', () => {
  test('a non-object jsonSubset expectation is compared exactly', () => {
    expect(matchBody({ kind: 'jsonSubset', value: [1, 2] }, '{"a":1}')).not.toBeNull();
    expect(matchBody({ kind: 'jsonSubset', value: null }, '{"a":1}')).not.toBeNull();
    expect(matchBody({ kind: 'jsonSubset', value: [1, 2] }, '[1,2]')).toBeNull();
    expect(matchBody({ kind: 'jsonSubset', value: 5 }, '5')).toBeNull();
  });
});
