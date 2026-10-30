/**
 * The CLI entry's usage path: a wrong command line prints the usage and
 * exits 2 without touching any adapter; an unsafe run id is refused in one
 * line with exit 2.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envSecrets } from './compose';
import { main } from './index';

const scratch = mkdtempSync(join(tmpdir(), 'factory-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runCli(argv: readonly string[]): Promise<{ code: number; lines: string[] }> {
  const out: string[] = [];
  const code = await main(argv, { env: {}, write: (line) => out.push(line), exit: () => undefined });
  return { code, lines: out };
}

test.each([[[]], [['deploy']], [['run']], [['run', 'spec.md', '--runtimes', 'pnpm']], [['intervene', 'r1']]])(
  '%j is a usage error: exit 2 with the usage text',
  async (argv) => {
    const lines: string[] = [];
    const code = await main(argv, { env: {}, write: (line) => lines.push(line), exit: () => undefined });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('usage:');
  },
);

test.each([[['report', '../etc']], [['intervene', '-r1', 'note']], [['report', '.hidden']]])(
  '%j names an unsafe run id: a one-line refusal and exit 2',
  async (argv) => {
    const lines: string[] = [];
    const code = await main(argv, { env: {}, write: (line) => lines.push(line), exit: () => undefined });
    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('refused: the run id is not a safe directory name');
  },
);

test('an empty spec, a directory and a spec name that is no slug are one-line usage errors', async () => {
  const empty = join(scratch, 'empty.md');
  writeFileSync(empty, '');
  const badName = join(scratch, '_draft.md');
  writeFileSync(badName, '# Draft\n');
  const directory = join(scratch, 'dir.md');
  mkdirSync(directory);
  for (const spec of [empty, badName, directory]) {
    const result = await runCli(['run', spec]);
    expect(result.code).toBe(2);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toStartWith('invalid spec');
  }
});

test('a non-empty --out the factory did not create is refused before anything starts', async () => {
  const spec = join(scratch, 'tool.md');
  writeFileSync(spec, '# Tool\n');
  const out = join(scratch, 'project');
  mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'keep');
  const result = await runCli(['run', spec, '--out', out]);
  expect(result.code).toBe(2);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toContain('not created by the factory');
});

test('the redaction secrets are every provider and Mozaik key set in the environment', () => {
  const env = { ZAI_API_KEY: 'a', FALLBACK_API_KEY: '', JIGJOY_ANTHROPIC_API_KEY: 'b', MOZAIK_API_KEY: 'c', OTHER: 'd' };
  expect([...envSecrets(env)].toSorted()).toEqual(['a', 'b', 'c']);
});
