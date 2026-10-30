/**
 * Failure paths of the HTTP example check (the parsing is tested in the
 * domain): a delivered server whose answers differ from the spec, and a server that
 * never listens, or one that listens on the IPv6 loopback only. Both
 * practice specs' examples must parse.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupFixturePackages, fixturePackage } from '../src/adapters/check-runner/testing/fixture-package';
import { createDeadline } from './e2e-process';
import { hasHttpExamples, runHttpExamples, type HttpExample } from './e2e-http';
import { readSpecChecks } from './e2e';

afterAll(cleanupFixturePackages);

describe('the practice specs', () => {
  const spec = (name: string): string => readFileSync(join(import.meta.dir, '..', 'examples', 'specs', name), 'utf8');

  test('notes-api has HTTP examples, demo-units and wordfreq CLI examples', () => {
    const notes = readSpecChecks(spec('notes-api.md'));
    expect(notes.kind).toBe('http');
    expect(notes.kind === 'http' ? notes.examples.length : 0).toBe(13);
    const units = readSpecChecks(spec('demo-units.md'));
    expect(units.kind === 'cli' ? [units.commandName, units.examples.length] : units).toEqual(['units', 8]);
    expect(hasHttpExamples(spec('wordfreq.md'))).toBe(false);
  });
});

/** A Node server that answers every request with status 200 and `{"ok":true}`. */
const OK_SERVER = `require('node:http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"ok":true}'); }).listen(Number(process.env.PORT));`;

describe('runHttpExamples', () => {
  const examples: HttpExample[] = [
    { method: 'GET', path: '/a', body: undefined, expectedStatus: 200, expectedBody: { value: { ok: true } }, raw: 'GET /a' },
    { method: 'POST', path: '/b', body: '{"x":1}', expectedStatus: 201, expectedBody: undefined, raw: 'POST /b' },
    { method: 'GET', path: '/c', body: undefined, expectedStatus: 200, expectedBody: { value: { ok: false } }, raw: 'GET /c' },
  ];

  test('reports every example whose status or body differs from the spec', async () => {
    const dir = await fixturePackage({
      'package.json': JSON.stringify({ name: 'http-fixture', private: true, scripts: { start: 'node server.js' } }),
      'server.js': OK_SERVER,
    });
    const results = await runHttpExamples(dir, examples, createDeadline(60_000));
    expect(results.map((r) => r.mismatch === null)).toEqual([true, false, false]);
    expect(results[1]?.mismatch).toContain('expected status 201, got 200');
    expect(results[2]?.mismatch).toContain('body');
  });

  test('reaches a server that listens on the IPv6 loopback only (macOS `localhost`)', async () => {
    const dir = await fixturePackage({
      'package.json': JSON.stringify({ name: 'http-fixture', private: true, scripts: { start: 'node server.js' } }),
      'server.js': OK_SERVER.replace('Number(process.env.PORT))', "Number(process.env.PORT), '::1')"),
    });
    const results = await runHttpExamples(dir, examples.slice(0, 1), createDeadline(60_000));
    expect(results.map((r) => r.mismatch)).toEqual([null]);
  }, 30_000);

  test('fails every example when the server never listens', async () => {
    const dir = await fixturePackage({
      'package.json': JSON.stringify({ name: 'http-fixture', private: true, scripts: { start: 'node -e "process.exit(0)"' } }),
    });
    const results = await runHttpExamples(dir, examples, createDeadline(60_000));
    expect(results.map((r) => r.mismatch)).toEqual(examples.map(() => 'server start timeout'));
  });
});
