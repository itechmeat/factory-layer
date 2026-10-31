/**
 * The startup check of the hidden run: exactly the committable files of one
 * delivery are copied into a scratch directory, installed as a grader would
 * (`npm ci` against the lock file, which catches a lock out of step with
 * package.json; `npm install` without one) and without lifecycle
 * scripts in the Node-only environment (no bun on the PATH), every declared
 * bin is started with `node <bin> --help` and stdin closed (a module or syntax error, or a
 * nonzero exit with an uncaught exception, fails it; a bin the start script
 * launches is a server and is left to the server check), and a package with a start
 * script is started on a free port until it accepts a TCP connection, on
 * both loopback stacks (macOS resolves localhost to ::1). Invariant: every
 * wait is bounded by the caller's deadline (10 s per bin, 15 s for the
 * server), and nothing keeps running when the check returns.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { runCommand } from '../src/adapters/check-runner/process';
import { withScratchHome } from '../src/adapters/child-env';
import type { CommandOutcome } from '../src/ports/check-runner';
import { nodeOnlyEnv } from '../src/adapters/node-only-env';
import { npmArgs } from '../src/adapters/package-guard';
import {
  INSTALL_TIMEOUT_MS,
  failedDetail,
  outputTail,
  readManifest,
  realTempDir,
  type PackageManifestType,
  type StepOutcome,
} from './hidden-run-steps';

/** The timeout of one `node <bin> --help` run, in milliseconds. */
export const BIN_TIMEOUT_MS = 10_000;

/** The bound of the server start wait, in milliseconds. */
export const SERVER_START_TIMEOUT_MS = 15_000;

/** How often the port is probed while waiting for the server, in milliseconds. */
export const SERVER_START_POLL_MS = 100;

/** Output that means the bin or the server cannot run, wherever the exit code lands. */
export const FAILURE_MARKERS = ['Cannot find module', 'ERR_MODULE_NOT_FOUND', 'SyntaxError'] as const;

/** The longest directory prefix shared by every repo-relative path, with its trailing slash. */
export function commonDirOf(files: readonly string[]): string {
  if (files.length === 0) return '';
  let prefix = files[0]?.split('/').slice(0, -1) ?? [];
  for (const file of files) {
    const parts = file.split('/');
    const kept: string[] = [];
    for (let index = 0; index < prefix.length && index < parts.length - 1; index += 1) {
      if (parts[index] !== prefix[index]) break;
      kept.push(prefix[index] ?? '');
    }
    prefix = kept;
  }
  return prefix.length === 0 ? '' : `${prefix.join('/')}/`;
}

/** The bin files of one manifest: a string bin is the one file, a record bin lists its files. */
export function binsOf(manifest: PackageManifestType): readonly string[] {
  if (typeof manifest.bin === 'string') return [manifest.bin];
  return Object.values(manifest.bin ?? {});
}

/**
 * True when the start script launches `bin`: a token of the script resolves
 * to the bin's path, or the script runs the package directory (`node .`) and
 * `main` resolves to it. Such a bin is a server; `--help` would start it.
 */
export function launchedByStart(bin: string, manifest: PackageManifestType, packageDir: string): boolean {
  const start = manifest.scripts?.['start'];
  if (start === undefined) return false;
  const target = resolvePath(packageDir, bin);
  const scripts = nodeScripts(start.split(/\s+/).filter((token) => token !== ''));
  if (scripts.some((script) => resolvePath(packageDir, script) === target)) return true;
  return (
    manifest.main !== undefined &&
    resolvePath(packageDir, manifest.main) === target &&
    scripts.some((script) => resolvePath(packageDir, script) === resolvePath(packageDir))
  );
}

/** The script operand of every `node` command in a start script: the first non-flag token after `node`. */
function nodeScripts(tokens: readonly string[]): string[] {
  const scripts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'node') continue;
    const operand = tokens.slice(index + 1).find((token) => !token.startsWith('-'));
    if (operand !== undefined) scripts.push(operand);
  }
  return scripts;
}

/** A free TCP port on the loopback, taken from a listener on port 0 and closed. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('the system gave no port'))));
    });
  });
}

/** One TCP connect attempt; true when it is accepted. */
function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Polls both loopback stacks (macOS resolves localhost to ::1) until one
 * accepts, the caller's bound passes, or shouldStop reports the server
 * process is already gone.
 */
async function waitUntilListening(port: number, timeoutMs: number, shouldStop: () => boolean): Promise<boolean> {
  const hosts = ['127.0.0.1', '::1'] as const;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    for (const host of hosts) {
      if (await tryConnect(host, port)) return true;
    }
    if (shouldStop()) return false;
    if (performance.now() >= deadline) return false;
    await Bun.sleep(SERVER_START_POLL_MS);
  }
}

/** The first failure marker in the output, or null. */
function markerIn(text: string): string | null {
  return FAILURE_MARKERS.find((marker) => text.includes(marker)) ?? null;
}

/** The error line of an uncaught exception on stderr (an `Error` line at a line start and a stack line `    at `), or null. */
function uncaughtException(stderr: string): string | null {
  const line = /^\w*Error\b.*$/m.exec(stderr)?.[0];
  return line !== undefined && /^ {4}at /m.test(stderr) ? line : null;
}

/**
 * Runs `node <bin> --help` bounded. A module or syntax error fails it
 * whatever the exit code; a nonzero exit fails it only with an uncaught
 * exception on stderr (a usage message with exit 1 passes).
 */
async function checkBin(bin: string, packageDir: string, env: Readonly<Record<string, string>>, boundMs: number): Promise<StepOutcome> {
  const outcome = await runCommand({
    command: 'node',
    args: [bin, '--help'],
    cwd: packageDir,
    timeoutMs: boundMs,
    env,
    secrets: [],
    ignoreStdin: true,
  });
  const output = `${outcome.stdout}\n${outcome.stderr}`;
  const marker = markerIn(output);
  if (marker !== null) return { ok: false, detail: `node ${bin} --help: the output names ${marker}: ${outputTail(output)}` };
  if (outcome.spawnFailure !== null) return { ok: false, detail: `node ${bin} --help: ${outcome.spawnFailure}` };
  if (outcome.timedOut) return { ok: false, detail: `node ${bin} --help timed out after ${String(boundMs)} ms` };
  const uncaught = outcome.exitCode === 0 ? null : uncaughtException(outcome.stderr);
  if (uncaught !== null) {
    return { ok: false, detail: `node ${bin} --help exited ${String(outcome.exitCode)} with an uncaught exception: ${uncaught}` };
  }
  return { ok: true, detail: `node ${bin} --help exited ${String(outcome.exitCode)}` };
}

/** What starting the server produced: whether a connection was accepted, and the raw outcome. */
interface ServerStart {
  readonly accepted: boolean;
  readonly outcome: CommandOutcome;
}

/**
 * Runs `npm run start` on `port` and waits until a TCP connection is
 * accepted on one of the loopback stacks, the process ends by itself, or
 * the bound passes; the server group is killed through the abort signal in
 * the accepted case, and the runCommand timeout covers the rest.
 */
async function startServer(packageDir: string, home: string, port: number, boundMs: number): Promise<ServerStart> {
  const controller = new AbortController();
  let done = false;
  const command = runCommand({
    command: 'npm',
    args: npmArgs(packageDir, ['run', 'start']),
    cwd: packageDir,
    timeoutMs: boundMs,
    env: nodeOnlyEnv(home, { PORT: String(port), NO_COLOR: '1', FORCE_COLOR: '0' }),
    secrets: [],
    stdin: '',
    signal: controller.signal,
  });
  const accepted = await Promise.race([waitUntilListening(port, boundMs, () => done), command.then(() => false)]);
  done = true;
  if (accepted) controller.abort();
  const outcome = await command;
  return { accepted, outcome };
}

/**
 * Copy of exactly `files` into a temp dir, `npm ci --ignore-scripts` (as a grader installs; `npm install` when there is no package-lock.json), then each bin as `node <bin> --help` (stdin closed, 10 s; a bin the start script launches is skipped) and, with scripts.start, `npm run start` on a free PORT until a TCP connection is accepted (15 s); the server group is then killed. The whole check is bounded by `deadlineMs`.
 */
export async function startupCheck(repoRoot: string, files: readonly string[], deadlineMs: number): Promise<StepOutcome> {
  if (files.length === 0) return { ok: false, detail: 'no committable files' };
  const copyDir = realTempDir('factory-hidden-startup-');
  try {
    for (const file of files) {
      const target = join(copyDir, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(repoRoot, file), target);
    }
    const packageDir = join(copyDir, commonDirOf(files));
    const manifest = readManifest(packageDir, 'the committable files');
    if (!manifest.ok) return manifest.outcome;
    return await withScratchHome(async (home) => {
      const env = nodeOnlyEnv(home, { NO_COLOR: '1', FORCE_COLOR: '0' });
      const installer = existsSync(join(packageDir, 'package-lock.json')) ? 'ci' : 'install';
      const install = await runCommand({
        command: 'npm',
        args: npmArgs(packageDir, [installer, '--ignore-scripts']),
        cwd: packageDir,
        timeoutMs: Math.min(INSTALL_TIMEOUT_MS, deadlineMs - Date.now()),
        env,
        secrets: [],
        stdin: '',
      });
      if (install.exitCode !== 0 || install.timedOut) return { ok: false, detail: failedDetail(`npm ${installer}`, install) };
      const parts: string[] = [];
      for (const bin of binsOf(manifest.manifest)) {
        if (launchedByStart(bin, manifest.manifest, packageDir)) {
          parts.push('server bin, covered by start');
          continue;
        }
        const outcome = await checkBin(bin, packageDir, env, Math.min(BIN_TIMEOUT_MS, deadlineMs - Date.now()));
        if (!outcome.ok) return outcome;
        parts.push(outcome.detail);
      }
      if (manifest.manifest.scripts?.['start'] === undefined) {
        return { ok: true, detail: parts.join('; ') === '' ? 'no bin and no start script' : parts.join('; ') };
      }
      const port = await freePort();
      const server = await startServer(packageDir, home, port, Math.min(SERVER_START_TIMEOUT_MS, deadlineMs - Date.now()));
      const output = `${server.outcome.stdout}\n${server.outcome.stderr}`;
      const marker = markerIn(output);
      if (marker !== null) return { ok: false, detail: `npm run start: the output names ${marker}: ${outputTail(output)}` };
      if (!server.accepted) {
        const why = server.outcome.timedOut ? 'did not accept a connection in time' : 'exited before accepting a connection';
        return { ok: false, detail: `npm run start ${why}: ${outputTail(output)}` };
      }
      parts.push(`server accepted a connection on port ${String(port)}`);
      return { ok: true, detail: parts.join('; ') };
    });
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
}
