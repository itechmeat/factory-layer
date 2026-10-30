/**
 * Failure paths of the hidden-run startup check: a bin that cannot find
 * its import fails with the module error, a bin that throws fails while a
 * bin that prints its usage and exits 1 passes, an HTTP package is accepted on
 * the loopback, and a Bun-only start script fails in the Node-only
 * environment (no bun on the PATH).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startupCheck } from './hidden-run-startup';
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
  const second = mode === 'deliver-http' || mode === 'deliver-bun-http' ? 'server.js' : 'cli.js';
  return [`${mode}/package.json`, `${mode}/${second}`];
}

describe('startupCheck', () => {
  test('a plain CLI package passes', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'deliver-js'), Date.now() + 60_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('exited 0');
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

  test('a Bun-only start script fails without bun on the PATH', async () => {
    const root = makeRoot();
    const outcome = await startupCheck(root, deliver(root, 'deliver-bun-http'), Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
  }, 30_000);
});
