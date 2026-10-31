/**
 * The gates script the starter playbooks run: both playbooks carry the same
 * copy (APB runs only scripts under a version's own `scripts/`), a package
 * that passes every required gate is green, a failing test is red with the
 * gate named, and a package missing a required gate script is red even when
 * its tests pass.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUILD_GATES = join(import.meta.dir, '..', '.apb', 'playbooks', 'build-task', '1.0.0', 'scripts', 'gates.sh');
const INTEGRATE_GATES = join(import.meta.dir, '..', '.apb', 'playbooks', 'integrate', '2.0.0', 'scripts', 'gates.sh');

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A package with `scripts` and one bun test that passes or fails. */
function aPackage(scripts: Record<string, string>, testPasses: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-gates-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gates-fixture', type: 'module', scripts }));
  mkdirSync(join(dir, 'test'));
  writeFileSync(
    join(dir, 'test', 'x.test.ts'),
    `import { test, expect } from 'bun:test';\ntest('x', () => expect(1).toBe(${testPasses ? 1 : 2}));\n`,
  );
  return dir;
}

function runGates(dir: string): { exitCode: number; lastLine: string } {
  const result = Bun.spawnSync(['sh', BUILD_GATES], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const lines = result.stdout.toString().trim().split('\n');
  return { exitCode: result.exitCode, lastLine: lines.at(-1) ?? '' };
}

const EVERY_GATE = { typecheck: 'true', lint: 'true', 'format:check': 'true', test: 'bun test' };

describe('gates.sh', () => {
  test('both starter playbooks carry the same script', () => {
    expect(readFileSync(INTEGRATE_GATES, 'utf8')).toBe(readFileSync(BUILD_GATES, 'utf8'));
  });

  test('a package passing every required gate is green', () => {
    expect(runGates(aPackage(EVERY_GATE, true))).toEqual({
      exitCode: 0,
      lastLine: 'GATES: green: install typecheck lint format:check test',
    });
  }, 30_000);

  test('a failing test is red and names the gate', () => {
    expect(runGates(aPackage(EVERY_GATE, false))).toEqual({ exitCode: 1, lastLine: 'GATES: red: test' });
  }, 30_000);

  test('a package without the lint and typecheck scripts is red although its tests pass', () => {
    const { typecheck: _typecheck, lint: _lint, ...rest } = EVERY_GATE;
    expect(runGates(aPackage(rest, true))).toEqual({ exitCode: 1, lastLine: 'GATES: red: typecheck(missing) lint(missing)' });
  }, 30_000);
});
