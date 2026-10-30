/**
 * The authoring command's refusals before anything starts: an example file
 * inside the factory's run trees (where a spec or a run's output could
 * carry text aimed at the brain, symlinks resolved on both sides), a kind that is no slug, and an example
 * file without examples or a trial instruction are one-line usage errors.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authorCommand } from './author';

const root = mkdtempSync(join(tmpdir(), 'factory-author-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const EXAMPLE = '## Examples\n\n- write a README for a\n\n## Trial\n\nWrite it for b.\n';

async function author(taskKind: string, examplePath: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await authorCommand({ root, env: {}, write: (line) => lines.push(line), taskKind, examplePath });
  return { code, lines };
}

test.each(['runs', 'work', 'hidden', 'out'])('an example file under %s/ is refused', async (tree) => {
  mkdirSync(join(root, tree, 'r1'), { recursive: true });
  const file = join(root, tree, 'r1', 'spec.md');
  writeFileSync(file, EXAMPLE);
  const result = await author('readme', file);
  expect(result.code).toBe(2);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toContain(`inside the factory's ${tree}/ tree`);
});

test('a symlink outside the run trees that points into one is refused', async () => {
  mkdirSync(join(root, 'runs', 'r2'), { recursive: true });
  const target = join(root, 'runs', 'r2', 'spec.md');
  writeFileSync(target, EXAMPLE);
  const outside = mkdtempSync(join(tmpdir(), 'factory-author-link-'));
  const link = join(outside, 'example.md');
  symlinkSync(target, link);
  const result = await author('readme', link);
  rmSync(outside, { recursive: true, force: true });
  expect(result.code).toBe(2);
  expect(result.lines[0]).toContain("inside the factory's runs/ tree");
});

test('a file reached through a run tree that is a symlink to another directory is refused', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'factory-author-hidden-'));
  writeFileSync(join(elsewhere, 'spec.md'), EXAMPLE);
  const linkedRoot = mkdtempSync(join(tmpdir(), 'factory-author-root-'));
  symlinkSync(elsewhere, join(linkedRoot, 'hidden'));
  const lines: string[] = [];
  const code = await authorCommand({
    root: linkedRoot,
    env: {},
    write: (line) => lines.push(line),
    taskKind: 'readme',
    examplePath: join(elsewhere, 'spec.md'),
  });
  rmSync(linkedRoot, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
  expect(code).toBe(2);
  expect(lines[0]).toContain("inside the factory's hidden/ tree");
});

test('a kind that is no slug is refused', async () => {
  expect((await author('Read Me', join(root, 'x.md'))).code).toBe(2);
});

test('an example file without a trial instruction is refused', async () => {
  const file = join(root, 'no-trial.md');
  writeFileSync(file, '## Examples\n\n- one\n');
  const result = await author('readme', file);
  expect(result.code).toBe(2);
  expect(result.lines[0]).toContain('no `## Trial` instruction');
});
