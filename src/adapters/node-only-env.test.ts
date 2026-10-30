import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';

import { withScratchHome } from './child-env';
import { runCommand } from './check-runner/process';
import { cleanupFixturePackages, fixturePackage } from './check-runner/testing/fixture-package';
import { nodeOnlyEnv, toolDir } from './node-only-env';

/** The real path of a tool on the factory's PATH; the test needs it. */
function which(name: string): string {
  const found = Bun.which(name);
  if (found === null) throw new Error(`${name} is not on the PATH`);
  return found;
}

/** A fake `bun` that would run any script under node: if it were reachable, a Bun-only package would start. */
const FAKE_BUN = '#!/bin/sh\nexec node "$@"\n';

let scratch = '';
let homebrewLayout = '';
let homebrewPath = '';
const factoryPath = process.env['PATH'] ?? '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'factory-node-only-test-'));
  // One directory holding node, npm, npx and bun together, as Homebrew's bin does.
  homebrewLayout = join(scratch, 'bin');
  mkdirSync(homebrewLayout);
  for (const name of ['node', 'npm', 'npx']) symlinkSync(which(name), join(homebrewLayout, name));
  for (const name of ['bun', 'bunx']) {
    writeFileSync(join(homebrewLayout, name), FAKE_BUN);
    chmodSync(join(homebrewLayout, name), 0o755);
  }
  homebrewPath = [homebrewLayout, factoryPath].join(delimiter);
});

afterAll(async () => {
  process.env['PATH'] = factoryPath;
  rmSync(scratch, { recursive: true, force: true });
  await cleanupFixturePackages();
});

/** Runs `npm run start` in `dir` with `nodeOnlyEnv` built while the factory PATH is `path` (the Homebrew layout by default). */
async function npmStart(dir: string, path = homebrewPath): Promise<{ readonly exitCode: number | null; readonly stdout: string }> {
  return withScratchHome(async (home) => {
    process.env['PATH'] = path;
    let env;
    try {
      env = nodeOnlyEnv(home);
    } finally {
      process.env['PATH'] = factoryPath;
    }
    return runCommand({ command: 'npm', args: ['run', 'start'], cwd: dir, timeoutMs: 30_000, env, secrets: [] });
  });
}

function startScript(start: string): Promise<string> {
  return fixturePackage({
    'package.json': JSON.stringify({ name: 'node-only-fixture', private: true, scripts: { start } }),
    'server.js': "process.stdout.write('started under ' + (typeof Bun === 'undefined' ? 'node' : 'bun') + '\\n');\n",
  });
}

describe('toolDir', () => {
  test('links node and npm from the Bun directory and never bun or bunx', () => {
    const dir = toolDir(homebrewPath);
    expect(readlinkSync(join(dir, 'node'))).toBe(join(homebrewLayout, 'node'));
    expect(readlinkSync(join(dir, 'npm'))).toBe(join(homebrewLayout, 'npm'));
    expect(existsSync(join(dir, 'sh'))).toBe(true);
    expect(existsSync(join(dir, 'bun'))).toBe(false);
    expect(existsSync(join(dir, 'bunx'))).toBe(false);
  });

  test('a node that resolves to a bun binary is skipped for the next one on the PATH', () => {
    const disguised = join(scratch, 'disguised');
    mkdirSync(disguised);
    symlinkSync(join(homebrewLayout, 'bun'), join(disguised, 'node'));
    const dir = toolDir([disguised, homebrewLayout].join(delimiter));
    expect(readlinkSync(join(dir, 'node'))).toBe(join(homebrewLayout, 'node'));
  });
});

describe('nodeOnlyEnv', () => {
  test('a Node package starts with npm run start', async () => {
    const outcome = await npmStart(await startScript('node server.js'));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('started under node');
  });

  test('a Bun-only package fails because bun is not found', async () => {
    const outcome = await npmStart(await startScript('bun server.js'));
    expect(outcome.exitCode).toBe(127);
    expect(outcome.stdout).not.toContain('started under');
  });

  test('a variable of the factory outside the allowlist never reaches the child', async () => {
    process.env['FACTORY_NODE_ONLY_SENTINEL'] = 'leaked';
    try {
      const outcome = await npmStart(await startScript('node -e "process.stdout.write(String(process.env.FACTORY_NODE_ONLY_SENTINEL))"'));
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('undefined');
      expect(outcome.stdout).not.toContain('leaked');
    } finally {
      delete process.env['FACTORY_NODE_ONLY_SENTINEL'];
    }
  });
});

/** A link at `link` to `target`, relative to the link's directory, as Homebrew and the Bun installer make them. */
function relativeLink(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), target), link);
}

/**
 * The macOS layouts side by side: `~/.bun/bin` first on the PATH (the Bun
 * installer: `bun` and a `bunx` link to it), then an Apple Silicon Homebrew
 * prefix whose `bin` links into `Cellar` and `lib/node_modules` with
 * relative links, Bun installed there too.
 */
function macLayouts(): { readonly path: string; readonly brewBin: string } {
  const bunBin = join(scratch, 'home', '.bun', 'bin');
  mkdirSync(bunBin, { recursive: true });
  writeFileSync(join(bunBin, 'bun'), FAKE_BUN);
  chmodSync(join(bunBin, 'bun'), 0o755);
  relativeLink(join(bunBin, 'bun'), join(bunBin, 'bunx'));
  const brew = join(scratch, 'opt', 'homebrew');
  const cellarNode = join(brew, 'Cellar', 'node', '24.0.0', 'bin', 'node');
  mkdirSync(dirname(cellarNode), { recursive: true });
  symlinkSync(which('node'), cellarNode);
  const cellarBun = join(brew, 'Cellar', 'bun', '1.4.4', 'bin', 'bun');
  mkdirSync(dirname(cellarBun), { recursive: true });
  writeFileSync(cellarBun, FAKE_BUN);
  chmodSync(cellarBun, 0o755);
  const npmCli = join(brew, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli');
  mkdirSync(dirname(npmCli), { recursive: true });
  symlinkSync(which('npm'), npmCli);
  const brewBin = join(brew, 'bin');
  relativeLink(cellarNode, join(brewBin, 'node'));
  relativeLink(cellarBun, join(brewBin, 'bun'));
  relativeLink(cellarBun, join(brewBin, 'bunx'));
  relativeLink(npmCli, join(brewBin, 'npm'));
  return { path: [bunBin, brewBin, factoryPath].join(delimiter), brewBin };
}

describe('macOS layouts', () => {
  test('with ~/.bun/bin before the Homebrew bin, node and npm come from Homebrew and no bun is reachable', async () => {
    const { path, brewBin } = macLayouts();
    const dir = toolDir(path);
    expect(readlinkSync(join(dir, 'node'))).toBe(join(brewBin, 'node'));
    expect(readlinkSync(join(dir, 'npm'))).toBe(join(brewBin, 'npm'));
    expect(existsSync(join(dir, 'bun'))).toBe(false);
    expect(existsSync(join(dir, 'bunx'))).toBe(false);
    const node = await npmStart(await startScript('node server.js'), path);
    expect(node.exitCode).toBe(0);
    expect(node.stdout).toContain('started under node');
    const bun = await npmStart(await startScript('bun server.js'), path);
    expect(bun.exitCode).toBe(127);
  });
});
