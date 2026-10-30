/**
 * The doctor's bash check: bash 4 or newer is ok with its path and major
 * version, bash 3.x is a warning with the `brew install bash` hint, and a
 * missing or foreign shell fails.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bashReport, nodeStartReport } from './doctor-checks';

let scratch = '';

/** An executable that prints `banner` for any arguments. */
function fakeBash(name: string, banner: string): string {
  const file = join(scratch, name);
  writeFileSync(file, `#!/bin/sh\necho '${banner}'\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'factory-doctor-bash-'));
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('bash 5 is ok with its path and major version', async () => {
  const file = fakeBash('bash5', 'GNU bash, version 5.2.37(1)-release (aarch64-apple-darwin24)');
  expect(await bashReport(file, new AbortController().signal)).toBe(`${file} (bash 5)`);
});

test('bash 3.2 is a warning with the install hint', async () => {
  const file = fakeBash('bash3', 'GNU bash, version 3.2.57(1)-release (arm64-apple-darwin23)');
  const report = await bashReport(file, new AbortController().signal);
  if (typeof report === 'string') throw new Error('expected a warning');
  expect(report.warning).toContain('brew install bash');
  expect(report.warning).toContain('bash 3');
});

test('a shell that does not report a bash version fails', async () => {
  const file = fakeBash('other', 'dash 0.5');
  await expect(bashReport(file, new AbortController().signal)).rejects.toThrow('did not report a bash version');
});

test('a missing shell fails', async () => {
  await expect(bashReport(join(scratch, 'absent'), new AbortController().signal)).rejects.toThrow('not on the PATH');
});

/** Runs `nodeStartReport` with the factory PATH set to `path`. */
async function nodeReport(path: string): Promise<string> {
  const saved = process.env['PATH'];
  process.env['PATH'] = path;
  try {
    return await nodeStartReport(new AbortController().signal);
  } finally {
    process.env['PATH'] = saved;
  }
}

test('node that starts in the generated-code environment is ok with its version', async () => {
  const bin = join(scratch, 'good-node');
  mkdirSync(bin);
  const file = join(bin, 'node');
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${file}"; else echo v24.0.0; fi\n`);
  chmodSync(file, 0o755);
  expect(await nodeReport(bin)).toContain('v24.0.0');
});

test('a node shim that cannot start under the scratch HOME fails with the exit code', async () => {
  const bin = join(scratch, 'shim-node');
  mkdirSync(bin);
  const file = join(bin, 'node');
  writeFileSync(file, '#!/bin/sh\necho "no such node" >&2\nexit 126\n');
  chmodSync(file, 0o755);
  await expect(nodeReport(bin)).rejects.toThrow('exit 126');
});
