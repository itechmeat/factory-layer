/**
 * Failure paths of the hidden-run startup check: a bin that cannot find
 * its import fails with the module error, a bin that throws fails while a
 * bin that prints its usage and exits 1 passes, a server bin the start script
 * launches is covered by the start check, a CLI bin runs with stdin closed and
 * a hanging one times out, an HTTP package is accepted on the loopback, a Bun-only start script fails in the Node-only
 * environment (no bun on the PATH), a lock file out of step with
 * package.json fails the install as `npm ci` would for a grader, and a
 * start script that runs a command-line bin which exits 0 is a CLI.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { launchedByStart, startupCheck } from './hidden-run-startup';
import { runFakeFactory } from './testing/hidden-fake-factory';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hidden-run-startup-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Delivers `mode` into its own directory under root and returns its repo-relative committable files. */
function deliver(root: string, mode: string): readonly string[] {
  runFakeFactory(join(root, mode), mode);
  const second =
    mode === 'deliver-http' || mode === 'deliver-bun-http' ? 'server.js' : mode.startsWith('server-') ? 'dist/src/main.js' : 'cli.js';
  return [`${mode}/package.json`, `${mode}/${second}`];
}

describe('startupCheck', () => {
  test('a plain CLI package passes', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'deliver-js'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('exited 0');
  });

  test('a lock file out of step with package.json fails the install', async () => {
    const root = makeRoot();
    const files = deliver(root, 'deliver-js');
    const manifestPath = join(root, 'deliver-js', 'package.json');
    const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, devDependencies: { typescript: '7.0.2' } }));
    const lock = { name: manifest['name'], lockfileVersion: 3, requires: true, packages: { '': { name: manifest['name'] } } };
    writeFileSync(join(root, 'deliver-js', 'package-lock.json'), JSON.stringify(lock));
    const outcome = await startupCheck(root, [...files, 'deliver-js/package-lock.json'], Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('npm ci');
  });

  test('a bin with a missing import fails with the module error', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'missing-import'), Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  }, 30_000);

  test('a bin that throws on --help fails with its uncaught error', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'throwing-bin'), Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('Error: boom');
  }, 30_000);

  test('a bin that prints its usage and exits 1 on --help passes', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'usage-exit'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('exited 1');
  }, 30_000);

  test('an HTTP package is accepted on the loopback', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'deliver-http'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('accepted a connection');
  }, 30_000);

  test('a command-line bin that the start script runs and that exits 0 is a CLI, checked with --help', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'cli-start'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('exited 0');
    expect(outcome.detail).toContain('start runs the command-line tool and exited 0');
  }, 30_000);

  test('a server bin that exits 0 before it listens is still a failed server, not a CLI', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'dead-server-bin'), Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('exited before accepting a connection');
  }, 30_000);

  test('a server bin that the start script launches is not run with --help', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'server-bin'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('server bin, covered by start');
    expect(outcome.detail).toContain('accepted a connection');
    expect(outcome.detail).not.toContain('--help');
  }, 30_000);

  test('a server bin that main names under a `node .` start script is covered too', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'server-main-bin'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('server bin, covered by start');
  }, 30_000);

  test('a CLI bin runs with stdin closed, so a stdin reader cannot hang', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'stdin-closed-bin'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('exited 0');
  }, 30_000);

  test('a CLI bin that keeps running on --help still fails with a timeout', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'hanging-bin'), Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('timed out');
  }, 30_000);

  test('a Bun-only start script fails without bun on the PATH', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'deliver-bun-http'), Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
  }, 30_000);
});

describe('launchedByStart', () => {
  test('only the script operand of node counts, not a bin named as an argument', () => {
    const dir = '/pkg';
    expect(launchedByStart('dist/server.js', { scripts: { start: 'node --enable-source-maps dist/server.js' } }, dir)).toBe(true);
    expect(launchedByStart('dist/cli.js', { scripts: { start: 'node dist/server.js --config dist/cli.js' } }, dir)).toBe(false);
    expect(launchedByStart('dist/main.js', { main: 'dist/main.js', scripts: { start: 'node .' } }, dir)).toBe(true);
  });
});
