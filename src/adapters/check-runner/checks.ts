/**
 * The CLI and command acceptance checks: a CLI check runs the package's CLI
 * entry (`bin`, else `main`) as `node <entry>` with the check's arguments
 * and stdin; a command check runs one shell command with the package's own
 * commands (its `bin` names, each run under `node`) on the PATH, as after
 * installing the package; a `bin` name that is not one plain file name is
 * skipped and named in the result. Every command sees only the Node-only
 * environment of the batch (no `bun` on the PATH), as a Node-only grader
 * would run the package. Invariant: a check passes
 * only when all of its expectations hold, every mismatch is named with its
 * expected and actual value, and nothing that leaves this module carries a
 * secret.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CheckResult, CliCheck, CommandCheck, ExpectedText } from '../../domain/acceptance';

import type { CommandOutcome } from '../../ports/check-runner';
import type { ChildEnv } from '../child-env';
import { nodeOnlyEnv } from '../node-only-env';
import { bashCommand } from '../shell';
import type { PackageJson } from './package-json';
import { readPackageJson } from './package-json';
import { redactAndCap } from './output';
import { runCommand, type Batch } from './process';

type CheckStatus = CheckResult['status'];

/** Redacts and caps one outbound text of a check result. */
function outbound(text: string, secrets: readonly string[]): string {
  return redactAndCap(text, secrets);
}

/** Builds a result with every outbound text redacted. */
export function checkResult(
  checkId: string,
  status: CheckStatus,
  reasons: readonly string[],
  detail: string,
  secrets: readonly string[],
): CheckResult {
  return {
    checkId,
    status,
    reasons: reasons.map((reason) => outbound(reason, secrets)),
    detail: outbound(detail, secrets),
  };
}

/** The mismatch reason for one stream against one expectation, or null when it holds. */
export function matchText(stream: 'stdout' | 'stderr', text: string, expected: ExpectedText): string | null {
  if (expected.kind === 'exact') {
    return text === expected.value ? null : `${stream}: expected exact ${JSON.stringify(expected.value)}, got ${JSON.stringify(text)}`;
  }
  if (expected.kind === 'substring') {
    return text.includes(expected.value)
      ? null
      : `${stream}: expected substring ${JSON.stringify(expected.value)}, got ${JSON.stringify(text)}`;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(expected.pattern);
  } catch (error) {
    return `${stream}: invalid regex ${JSON.stringify(expected.pattern)}: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  return pattern.test(text) ? null : `${stream}: expected regex ${JSON.stringify(expected.pattern)}, got ${JSON.stringify(text)}`;
}

/** The CLI entry: `bin` (a string, or the sole value of a one-key object), else `main`. */
export function cliEntry(pkg: PackageJson | null): string | null {
  const bin = pkg?.bin;
  if (typeof bin === 'string') return bin;
  if (bin !== undefined) {
    const values = Object.values(bin);
    const sole = values.length === 1 ? values[0] : undefined;
    if (sole !== undefined) return sole;
  }
  return pkg?.main ?? null;
}

/** The captured streams of an outcome as one detail text ('' when both are empty). */
function streamsDetail(outcome: CommandOutcome): string {
  const parts: string[] = [];
  if (outcome.stdout !== '') parts.push(`stdout:\n${outcome.stdout}`);
  if (outcome.stderr !== '') parts.push(`stderr:\n${outcome.stderr}`);
  return parts.join('\n');
}

/** The exit-code part of a CLI or command check verdict. */
function exitCodeReason(expectedExitCode: number, outcome: CommandOutcome, timeoutMs: number): string | null {
  if (outcome.timedOut) return `expected exit code ${expectedExitCode}, but the command timed out after ${timeoutMs} ms`;
  if (outcome.exitCode !== expectedExitCode) return `expected exit code ${expectedExitCode}, got ${outcome.exitCode}`;
  return null;
}

/** Runs one CLI check against the package in `dir`. */
export async function runCliCheck(dir: string, check: CliCheck, batch: Batch): Promise<CheckResult> {
  const { secrets } = batch;
  const entry = cliEntry(await readPackageJson(dir));
  if (entry === null) {
    return checkResult(check.id, 'failed', ['no CLI entry: package.json has no bin and no main'], '', secrets);
  }
  const outcome = await runCommand({
    command: 'node',
    args: [entry, ...check.args],
    cwd: dir,
    timeoutMs: check.timeoutMs,
    ...(check.stdin === undefined ? {} : { stdin: check.stdin }),
    env: nodeOnlyEnv(batch.home),
    secrets,
    signal: batch.signal,
  });
  if (outcome.spawnFailure !== null) {
    return checkResult(check.id, 'errored', [`the CLI could not run: ${outcome.spawnFailure}`], '', secrets);
  }
  const reasons: (string | null)[] = [exitCodeReason(check.expectedExitCode, outcome, check.timeoutMs)];
  if (check.expectedStdout !== undefined) reasons.push(matchText('stdout', outcome.stdout, check.expectedStdout));
  if (check.expectedStderr !== undefined) reasons.push(matchText('stderr', outcome.stderr, check.expectedStderr));
  const mismatches = reasons.filter((reason): reason is string => reason !== null);
  return checkResult(check.id, mismatches.length === 0 ? 'passed' : 'failed', mismatches, streamsDetail(outcome), secrets);
}

/** The package's commands: each `bin` name (a string `bin` is named after the package) with its file. */
export function binCommands(pkg: PackageJson | null): readonly (readonly [string, string])[] {
  const bin = pkg?.bin;
  if (bin === undefined) return [];
  if (typeof bin === 'string') return pkg?.name === undefined ? [] : [[pkg.name.replace(/^@[^/]+\//, ''), bin]];
  return Object.entries(bin);
}

/** A `bin` name that is one plain file name: safe to create as a shim inside the shim directory. */
const SAFE_BIN_NAME = /^[A-Za-z0-9._-]+$/;

/** True for a command name that may become a shim file (`.` and `..` name directories, not files). */
export function isSafeBinName(name: string): boolean {
  return SAFE_BIN_NAME.test(name) && name !== '.' && name !== '..';
}

/** The environment of a command check, and the unsafe `bin` names that got no shim. */
interface BinEnv {
  readonly env: ChildEnv;
  readonly skipped: readonly string[];
}

/** Runs `body` with a PATH whose first directory holds one `node` shim per safely named command of the package in `dir`. */
async function withPackageBins<T>(dir: string, batch: Batch, body: (bins: BinEnv) => Promise<T>): Promise<T> {
  const commands = binCommands(await readPackageJson(dir));
  const skipped = commands.map(([name]) => name).filter((name) => !isSafeBinName(name));
  const safe = commands.filter(([name]) => isSafeBinName(name));
  if (safe.length === 0) return body({ env: nodeOnlyEnv(batch.home), skipped });
  const shims = await mkdtemp(join(tmpdir(), 'factory-bin-'));
  try {
    for (const [name, file] of safe) {
      const shim = join(shims, name);
      await writeFile(shim, `#!/bin/sh\nexec node ${JSON.stringify(resolve(dir, file))} "$@"\n`);
      await chmod(shim, 0o755);
    }
    const env = nodeOnlyEnv(batch.home);
    return await body({ env: { ...env, PATH: `${shims}:${env['PATH'] ?? ''}` }, skipped });
  } finally {
    await rm(shims, { recursive: true, force: true });
  }
}

/** The detail line naming the skipped `bin` names, or nothing. */
function skippedDetail(skipped: readonly string[]): string {
  return skipped.length === 0 ? '' : `skipped unsafe bin names: ${skipped.map((name) => JSON.stringify(name)).join(', ')}\n`;
}

/** Runs one command check (one shell command; exit code and, when given, its streams) in `dir`. */
export async function runCommandCheck(dir: string, check: CommandCheck, batch: Batch): Promise<CheckResult> {
  const { secrets } = batch;
  const { outcome, skipped } = await withPackageBins(dir, batch, async (bins) => ({
    skipped: bins.skipped,
    outcome: await runCommand({
      command: bashCommand(),
      args: ['-c', check.command],
      cwd: dir,
      timeoutMs: check.timeoutMs,
      env: bins.env,
      secrets,
      signal: batch.signal,
    }),
  }));
  if (outcome.spawnFailure !== null) {
    return checkResult(check.id, 'errored', [`the command could not run: ${outcome.spawnFailure}`], skippedDetail(skipped), secrets);
  }
  const reasons: (string | null)[] = [exitCodeReason(check.expectedExitCode, outcome, check.timeoutMs)];
  if (check.expectedStdout !== undefined) reasons.push(matchText('stdout', outcome.stdout, check.expectedStdout));
  if (check.expectedStderr !== undefined) reasons.push(matchText('stderr', outcome.stderr, check.expectedStderr));
  const mismatches = reasons.filter((reason): reason is string => reason !== null);
  return checkResult(
    check.id,
    mismatches.length === 0 ? 'passed' : 'failed',
    mismatches,
    skippedDetail(skipped) + streamsDetail(outcome),
    secrets,
  );
}
