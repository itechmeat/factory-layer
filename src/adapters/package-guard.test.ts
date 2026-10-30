import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from './check-runner/process';
import { withScratchHome } from './child-env';
import { nodeOnlyEnv } from './node-only-env';
import { missingPackageJson, npmArgs } from './package-guard';

let parent = '';

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'factory-package-guard-'));
  writeFileSync(join(parent, 'package.json'), JSON.stringify({ name: 'parent', private: true }));
});

afterAll(() => rmSync(parent, { recursive: true, force: true }));

describe('missingPackageJson', () => {
  test('names a directory without package.json and accepts one with it', () => {
    const child = join(parent, 'bare');
    mkdirSync(child, { recursive: true });
    expect(missingPackageJson(child)).toBe(`no package.json in ${child}`);
    expect(missingPackageJson(parent)).toBeNull();
  });
});

describe('npmArgs', () => {
  test('an npm install pinned to a directory never writes a lockfile into the parent', async () => {
    const child = join(parent, 'pinned');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'child', private: true }));
    const outcome = await withScratchHome(async (home) =>
      runCommand({
        command: 'npm',
        args: npmArgs(child, ['install', '--ignore-scripts']),
        cwd: child,
        timeoutMs: 60_000,
        env: nodeOnlyEnv(home),
        secrets: [],
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(parent, 'package-lock.json'))).toBe(false);
  });
});
