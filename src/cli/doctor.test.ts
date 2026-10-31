/**
 * The doctor's failure paths: a failing check and a check that never
 * answers are both reported with their fix, the others still pass, and the
 * exit code is 1.
 */

import { expect, test } from 'bun:test';

import { type DoctorCheck, runDoctor } from './doctor';

test('a failing and a hanging check fail with their fix, the rest pass, and doctor exits 1', async () => {
  let aborted = false;
  const checks: DoctorCheck[] = [
    { name: 'git', deadlineMs: 1000, fix: 'install git', run: async () => 'git version 2' },
    {
      name: 'apb',
      deadlineMs: 1000,
      fix: 'bun run apb:bootstrap',
      run: async () => {
        throw new Error('playbook build-task is not approved');
      },
    },
    {
      name: 'osb',
      deadlineMs: 50,
      fix: 'set FACTORY_OSB_VAULT',
      run: (signal) =>
        new Promise<string>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    },
  ];
  const lines: string[] = [];
  expect(await runDoctor(checks, (line) => lines.push(line))).toBe(1);
  expect(lines[0]).toStartWith('ok   git');
  expect(lines[1]).toContain('FAIL apb');
  expect(lines[1]).toContain('fix: bun run apb:bootstrap');
  expect(lines[2]).toContain('no answer within 50 ms');
  expect(aborted).toBe(true);
  expect(lines.at(-1)).toBe('doctor: 2 of 3 checks failed');
});

test('a warning prints as warn, keeps the exit code 0 and is counted', async () => {
  const checks: DoctorCheck[] = [
    { name: 'git', deadlineMs: 1000, fix: 'install git', run: async () => 'git version 2' },
    { name: 'bash', deadlineMs: 1000, fix: 'install bash', run: async () => ({ warning: '/bin/bash is bash 3; brew install bash' }) },
  ];
  const lines: string[] = [];
  expect(await runDoctor(checks, (line) => lines.push(line))).toBe(0);
  expect(lines[1]).toStartWith('warn bash');
  expect(lines[1]).toContain('brew install bash');
  expect(lines.at(-1)).toBe('doctor: no check failed, 1 warning');
});
