import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bashMajorVersion, pickBash } from './shell';

let scratch = '';
let executable = '';
let secondExecutable = '';
let notExecutable = '';
let missing = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'factory-shell-test-'));
  for (const dir of ['a', 'b', 'c']) mkdirSync(join(scratch, dir));
  executable = join(scratch, 'a', 'bash');
  secondExecutable = join(scratch, 'b', 'bash');
  notExecutable = join(scratch, 'c', 'bash');
  missing = join(scratch, 'none', 'bash');
  for (const file of [executable, secondExecutable]) {
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  }
  writeFileSync(notExecutable, '#!/bin/sh\n');
  chmodSync(notExecutable, 0o644);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('the first existing executable candidate wins', () => {
  expect(pickBash([missing, executable, secondExecutable])).toBe(executable);
});

test('a missing or non-executable candidate is skipped', () => {
  expect(pickBash([missing, notExecutable, secondExecutable])).toBe(secondExecutable);
});

test('without a usable candidate the shell is bash from the PATH', () => {
  expect(pickBash([missing, notExecutable])).toBe('bash');
  expect(pickBash([])).toBe('bash');
});

test('the major version is read from the first line of bash --version', () => {
  expect(bashMajorVersion('GNU bash, version 3.2.57(1)-release (arm64-apple-darwin23)\nCopyright')).toBe(3);
  expect(bashMajorVersion('GNU bash, version 5.2.37(1)-release (aarch64-apple-darwin24.2.0)')).toBe(5);
  expect(bashMajorVersion('not a shell')).toBeNull();
});
