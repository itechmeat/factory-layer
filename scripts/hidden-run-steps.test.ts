/**
 * The hidden-run steps: a duplicate spec name and an occupied output
 * directory fail planning, the factory argv is the exact one, the rewritten
 * ignore file is one line, the git listings keep node_modules out of the
 * committable files (and drop tracked paths missing on disk), the in-place
 * build puts the built files back (and leaves the delivery untouched when
 * the build fails), a failed copy back or a malformed manifest is a failed
 * step, the build copy lives at the real path of a symlinked temp root
 * (macOS /var), so npm writes node_modules keys into the lock file, and
 * the table marks unfinished steps.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OWNER_STEPS,
  buildInPlace,
  committableFiles,
  factoryArgv,
  ignoredFiles,
  planSpecs,
  readManifest,
  realGit,
  realTempDir,
  renderTable,
  rewriteGitignore,
} from './hidden-run-steps';
import { runFakeFactory, writeFakeSpec } from './testing/hidden-fake-factory';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hidden-run-steps-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('planSpecs', () => {
  test('plans one copy and output directory per spec', () => {
    const root = makeRoot();
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const spec = writeFakeSpec(root, 'deliver-js');
    const plans = planSpecs([spec], join(root, 'hidden'), scratch, new Date(2026, 5, 1, 10, 20, 30));
    expect(plans).toEqual([
      {
        name: 'deliver-js',
        specPath: spec,
        copyPath: join(scratch, 'deliver-js-102030.md'),
        outDir: join(root, 'hidden', 'deliver-js'),
      },
    ]);
  });

  test('a duplicate spec name is an error', () => {
    const root = makeRoot();
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const spec = writeFakeSpec(root, 'deliver-js');
    expect(() => planSpecs([spec, spec], join(root, 'hidden'), scratch, new Date())).toThrow(/share the name/);
  });

  test('a non-empty output directory is an error', () => {
    const root = makeRoot();
    const outDir = join(root, 'hidden', 'deliver-js');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'package.json'), '{}\n');
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const spec = writeFakeSpec(root, 'deliver-js');
    expect(() => planSpecs([spec], join(root, 'hidden'), scratch, new Date())).toThrow(
      /not empty; move or remove the old delivery, or pass --replace/,
    );
  });

  test('--replace removes an earlier factory delivery that holds the marker', () => {
    const root = makeRoot();
    const outDir = join(root, 'hidden', 'deliver-js');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, '.factory-delivery'), '');
    writeFileSync(join(outDir, 'old.js'), '\n');
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const spec = writeFakeSpec(root, 'deliver-js');
    const plans = planSpecs([spec], join(root, 'hidden'), scratch, new Date(), true);
    expect(plans.map((plan) => plan.outDir)).toEqual([outDir]);
    expect(existsSync(outDir)).toBe(false);
  });

  test('--replace refuses a directory without the marker and removes nothing, not even an earlier marked one', () => {
    const root = makeRoot();
    const marked = join(root, 'hidden', 'deliver-js');
    mkdirSync(marked, { recursive: true });
    writeFileSync(join(marked, '.factory-delivery'), '');
    const foreign = join(root, 'hidden', 'deliver-http');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'notes.txt'), 'mine\n');
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const specs = [writeFakeSpec(root, 'deliver-js'), writeFakeSpec(root, 'deliver-http')];
    expect(() => planSpecs(specs, join(root, 'hidden'), scratch, new Date(), true)).toThrow(
      /holds no \.factory-delivery; --replace removes only a factory delivery/,
    );
    expect(existsSync(join(marked, '.factory-delivery'))).toBe(true);
    expect(existsSync(join(foreign, 'notes.txt'))).toBe(true);
  });
});

describe('factoryArgv', () => {
  test('builds the exact factory argv', () => {
    const plan = { name: 'demo', specPath: '/x/demo.md', copyPath: '/s/demo-102030.md', outDir: '/h/demo' };
    expect(factoryArgv(['bun', 'run', 'src/cli/index.ts'], plan, '19:15', 3)).toEqual([
      'bun',
      'run',
      'src/cli/index.ts',
      'run',
      '/s/demo-102030.md',
      '--out',
      '/h/demo',
      '--cutoff',
      '19:15',
      '--task-concurrency',
      '3',
      '--deliver-unverified',
    ]);
  });
});

describe('rewriteGitignore', () => {
  test('writes exactly one line', () => {
    const dir = makeRoot();
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    rewriteGitignore(dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });
});

describe('committableFiles and ignoredFiles', () => {
  test('dist under hidden is committable, node_modules is ignored and dropped', async () => {
    const repo = makeRoot();
    writeFileSync(join(repo, '.gitignore'), ['dist/', 'node_modules/', '!hidden/**', 'hidden/**/node_modules/'].join('\n') + '\n');
    const initialized = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: repo, stdout: 'ignore', stderr: 'ignore' });
    expect(initialized.exitCode).toBe(0);
    mkdirSync(join(repo, 'hidden', 'x', 'dist'), { recursive: true });
    mkdirSync(join(repo, 'hidden', 'x', 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'hidden', 'x', 'dist', 'a.js'), 'exports.x = 1;\n');
    writeFileSync(join(repo, 'hidden', 'x', 'node_modules', 'a.js'), 'exports.x = 1;\n');
    const committed = await committableFiles(realGit, repo, 'hidden/x');
    expect(committed).toContain('hidden/x/dist/a.js');
    expect(committed.some((path) => path.split('/').includes('node_modules'))).toBe(false);
    expect(await ignoredFiles(realGit, repo, 'hidden/x')).toEqual([]);
  });

  test('a tracked path the new delivery no longer has is not committable', async () => {
    const repo = makeRoot();
    mkdirSync(join(repo, 'hidden', 'x'), { recursive: true });
    writeFileSync(join(repo, 'hidden', 'x', 'kept.js'), 'exports.x = 1;\n');
    const git = async (): Promise<string> => 'hidden/x/kept.js\0hidden/x/gone.js\0';
    expect(await committableFiles(git, repo, 'hidden/x')).toEqual(['hidden/x/kept.js']);
  });
});

describe('realTempDir', () => {
  test('a temp root behind a symlink, as /var on macOS, gives the real path npm will resolve', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'real-tmp'));
    symlinkSync(join(root, 'real-tmp'), join(root, 'linked-tmp'));
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = join(root, 'linked-tmp');
    let dir = '';
    try {
      dir = realTempDir('factory-hidden-build-');
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
    }
    expect(dir.startsWith(join(realpathSync(root), 'real-tmp', 'factory-hidden-build-'))).toBe(true);
  });
});

describe('buildInPlace', () => {
  test('the build output lands in the delivery and node_modules does not', async () => {
    const dir = join(makeRoot(), 'deliver-build');
    runFakeFactory(dir, 'deliver-build');
    const outcome = await buildInPlace(dir, Date.now() + 60_000);
    expect(outcome).toEqual({ ok: true, detail: 'built in a copy and copied back' });
    expect(readdirSync(join(dir, 'dist')).toSorted()).toEqual(['cli.js', 'commands.js']);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  }, 30_000);

  test('a failing build is a failed step and leaves the delivery unchanged', async () => {
    const dir = join(makeRoot(), 'deliver-build');
    runFakeFactory(dir, 'deliver-build');
    writeFileSync(join(dir, 'build.js'), "process.stderr.write('broken build\\n'); process.exit(3);\n");
    const before = readdirSync(dir).toSorted();
    const outcome = await buildInPlace(dir, Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('npm run build: exit');
    expect(outcome.detail).toContain('broken build');
    expect(readdirSync(dir).toSorted()).toEqual(before);
  }, 30_000);

  // Root reads a mode-000 file, so the copy back would not fail there.
  test.skipIf(process.getuid?.() === 0)(
    'a built file that cannot be copied back is a failed step, not a crash',
    async () => {
      const dir = join(makeRoot(), 'deliver-build');
      runFakeFactory(dir, 'deliver-build');
      writeFileSync(
        join(dir, 'build.js'),
        "const fs = require('node:fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/locked.js', '');\nfs.chmodSync('dist/locked.js', 0);\n",
      );
      const outcome = await buildInPlace(dir, Date.now() + 60_000);
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain('copy back');
    },
    30_000,
  );

  test('a package without a build script passes as is', async () => {
    const dir = join(makeRoot(), 'deliver-js');
    runFakeFactory(dir, 'deliver-js');
    expect(await buildInPlace(dir, Date.now() + 60_000)).toEqual({ ok: true, detail: 'no build script' });
  }, 30_000);

  test('a malformed package.json is a failed step, not a crash', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'package.json'), '{ "name": ');
    const outcome = await buildInPlace(dir, Date.now() + 60_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('package.json is not JSON');
  });
});

describe('readManifest', () => {
  test('an off-schema bin is a failed step naming package.json', () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ bin: 42 }));
    const read = readManifest(dir, 'the delivery');
    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.outcome.detail).toStartWith('package.json: ');
  });

  test('a missing package.json names where it was looked for', () => {
    const read = readManifest(makeRoot(), 'the delivery');
    expect(read.ok ? '' : read.outcome.detail).toBe('no package.json in the delivery');
  });
});

describe('renderTable and OWNER_STEPS', () => {
  test('one line per row, unfinished steps marked, failures named', () => {
    const table = renderTable([
      {
        name: 'todo-api',
        factory: 'exit 0',
        delivered: true,
        build: { ok: true, detail: 'no build script' },
        ignored: [],
        startup: { ok: false, detail: 'Cannot find module x' },
      },
      {
        name: 'csv-tool',
        factory: 'killed at the hard deadline',
        delivered: true,
        build: null,
        ignored: ['hidden/csv-tool/.env'],
        startup: null,
      },
    ]);
    const lines = table.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^name\s+factory\s+delivered\s+ignored\s+build\s+startup$/);
    expect(lines[1]).toContain('failed: Cannot find module x');
    const long = renderTable([
      {
        name: 'a',
        factory: 'exit 0',
        delivered: true,
        build: null,
        ignored: [],
        startup: { ok: false, detail: `node cli.js --help: the output names ERR_MODULE_NOT_FOUND: ${'at frame '.repeat(80)}` },
      },
    ]);
    expect(long).toContain('failed: node cli.js --help: the output names ERR_MODULE_NOT_FOUND');
    expect(lines[2]).toContain('killed at the hard deadline');
    expect(lines[2]?.match(/not checked: report time/g)).toHaveLength(2);
  });

  test('the owner steps stage hidden/, commit, push and check the remote', () => {
    expect(OWNER_STEPS).toContain('git add hidden/');
    expect(OWNER_STEPS).toMatch(/Commit and push/);
    expect(OWNER_STEPS).toMatch(/remote commit/);
  });
});
