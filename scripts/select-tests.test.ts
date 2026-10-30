/**
 * The `fast` tier's test selector.
 *
 * The claim under test is the one the tier rests on: a change is followed
 * UPWARDS through the import graph, so a test two modules above the edit is
 * selected, and a test that cannot see the edit at all is not. The second claim
 * is that the selector never
 * answers "nothing" when it simply could not see: a missing root is an error,
 * and a deleted module , whose importers have no edge left to follow , takes
 * every test rather than none.
 *
 * Everything runs against a throwaway tree on disk rather than the repository
 * itself, so the expectations are exact instead of "whatever `src/` happens to
 * look like".
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importerGraph, resolveSpecifier, selectTests, sourceFiles } from './select-tests';

/**
 * A three-layer tree: `leaf` <- `middle` <- `top`, each with its own test, plus an
 * `island` nothing imports and a `sideways` module reached only by a
 * side-effect import.
 */
const ROOT = mkdtempSync(join(import.meta.dir, '.select-tests-'));
mkdirSync(join(ROOT, 'nested'), { recursive: true });
writeFileSync(join(ROOT, 'leaf.ts'), 'export const leaf = 1;\n');
writeFileSync(join(ROOT, 'leaf.test.ts'), "import { leaf } from './leaf.ts';\nexport const a = leaf;\n");
writeFileSync(join(ROOT, 'middle.ts'), "import { leaf } from './leaf.js';\nexport const middle = leaf + 1;\n");
writeFileSync(join(ROOT, 'middle.test.ts'), "import { middle } from './middle.ts';\nexport const b = middle;\n");
writeFileSync(join(ROOT, 'nested', 'index.ts'), "import { middle } from '../middle.ts';\nexport const top = middle;\n");
writeFileSync(join(ROOT, 'top.test.ts'), "const load = () => import('./nested');\nexport const c = load;\n");
writeFileSync(join(ROOT, 'island.ts'), 'export const island = 0;\n');
writeFileSync(join(ROOT, 'island.test.ts'), "import { island } from './island.ts';\nexport const d = island;\n");
writeFileSync(join(ROOT, 'sideways.mts'), 'export const sideways = 2;\n');
writeFileSync(join(ROOT, 'sideways.test.ts'), "import './sideways.mjs';\nexport const e = 1;\n");

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const relative = (paths: readonly string[]): string[] => paths.map((path) => path.slice(ROOT.length + 1)).toSorted();

describe('resolveSpecifier', () => {
  test('resolves a plain relative specifier to its .ts file', () => {
    expect(resolveSpecifier(join(ROOT, 'middle.ts'), './leaf')).toBe(join(ROOT, 'leaf.ts'));
  });

  test("resolves the './x.mjs' spelling TypeScript uses for './x.mts'", () => {
    expect(resolveSpecifier(join(ROOT, 'middle.ts'), './sideways.mjs')).toBe(join(ROOT, 'sideways.mts'));
  });

  test('answers null for something that is not there', () => {
    expect(resolveSpecifier(join(ROOT, 'middle.ts'), './nowhere')).toBeNull();
  });

  test('answers null for a bare specifier: a dependency is not part of the graph', () => {
    expect(resolveSpecifier(join(ROOT, 'middle.ts'), 'three')).toBeNull();
  });
});

describe('importerGraph', () => {
  test('records a side-effect import, which has no `from` clause', () => {
    const graph = importerGraph(sourceFiles([ROOT]));
    expect(relative(graph.get(join(ROOT, 'sideways.mts')) ?? [])).toEqual(['sideways.test.ts']);
  });
});

describe('selectTests', () => {
  test('a leaf change reaches the tests of everything above it, and nothing else', () => {
    const selection = selectTests([ROOT], [join(ROOT, 'leaf.ts')]);
    expect(selection.everything).toBe(false);
    expect(relative(selection.tests)).toEqual(['leaf.test.ts', 'middle.test.ts', 'top.test.ts']);
  });

  test('a change to a module nothing imports selects only its own test', () => {
    expect(relative(selectTests([ROOT], [join(ROOT, 'island.ts')]).tests)).toEqual(['island.test.ts']);
  });

  test('a changed test file selects itself', () => {
    expect(relative(selectTests([ROOT], [join(ROOT, 'island.test.ts')]).tests)).toEqual(['island.test.ts']);
  });

  test('no change selects no test , an empty answer, not every test', () => {
    expect(selectTests([ROOT], []).tests).toEqual([]);
  });

  test('a changed file outside the roots is ignored rather than crashing the run', () => {
    expect(selectTests([ROOT], [join(ROOT, '..', 'somewhere-else.ts')]).tests).toEqual([]);
  });

  test('a DELETED module takes every test under the roots, and says which module', () => {
    const selection = selectTests([ROOT], [join(ROOT, 'gone.ts')]);
    expect(selection.everything).toBe(true);
    expect(selection.reason).toMatch(/deleted or renamed away/);
    expect(selection.reason).toContain('gone.ts');
    expect(relative(selection.tests)).toEqual(['island.test.ts', 'leaf.test.ts', 'middle.test.ts', 'sideways.test.ts', 'top.test.ts']);
  });

  test('a root that does not exist is an error, never an empty selection', () => {
    expect(() => selectTests([join(ROOT, 'no-such-root')], [])).toThrow(/root does not exist/);
  });

  test('a changed manifest takes every test: it is what the edges are built from', () => {
    const selection = selectTests([ROOT], [join(ROOT, 'package.json')], ROOT);
    expect(selection.everything).toBe(true);
    expect(selection.reason).toMatch(/manifest, lockfile or runner config changed/);
    expect(selection.tests.length).toBe(5);
  });

  test('a changed lockfile takes every test for the same reason', () => {
    expect(selectTests([ROOT], [join(ROOT, 'bun.lock')], ROOT).everything).toBe(true);
  });

  for (const config of ['bunfig.toml', join('scripts', 'fast-bunfig.toml')]) {
    test(`a changed runner config (${config}) takes every test: it can change how every test runs`, () => {
      expect(selectTests([ROOT], [join(ROOT, config)], ROOT).everything).toBe(true);
    });
  }
});

describe('the selector run against a real git repository', () => {
  test('an untracked module whose path has a space is still followed to its importers', () => {
    const repo = mkdtempSync(join(tmpdir(), 'select-tests-git-'));
    try {
      const git = (...args: string[]): void => {
        const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'core.hooksPath=/dev/null', ...args], {
          cwd: repo,
          encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      };
      git('init', '-q', '-b', 'main');
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src', 'user.test.ts'), "import { spaced } from './a b';\nexport const f = spaced;\n");
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      writeFileSync(join(repo, 'src', 'a b.ts'), 'export const spaced = 1;\n');

      // The fast tier exports its own base, which does not exist in this repository.
      const { FACTORY_FAST_BASE: _outerBase, ...env } = process.env;
      const run = spawnSync('bun', ['run', join(import.meta.dir, 'select-tests.ts'), 'src'], { cwd: repo, encoding: 'utf8', env });
      expect(run.status).toBe(0);
      expect(run.stdout.trim().split('\n')).toEqual(['src/user.test.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
