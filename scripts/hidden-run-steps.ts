/**
 * The steps of the hidden run: the spec plans, the exact factory argv, the
 * rewritten ignore file, the git listings of one delivery, the in-place
 * build from a scratch copy, the table and the owner's steps. Invariant:
 * every process runs through `runCommand` with the allowlisted environment
 * its step needs (Node-only for generated code, `gitEnv` for git), every
 * wait is bounded by the deadline its caller passes, and nothing here
 * changes git state.
 */

import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';

import { gitEnv, withScratchHome } from '../src/adapters/child-env';
import { nodeOnlyEnv } from '../src/adapters/node-only-env';
import { runCommand } from '../src/adapters/check-runner/process';
import { specNameFromFileName } from '../src/domain/spec';
import type { CommandOutcome } from '../src/ports/check-runner';

/** The caller's knobs of one hidden run. */
export interface HiddenOptions {
  readonly specPaths: readonly string[];
  /** Passed to `factory run --cutoff` as passed to the script. */
  readonly cutoff: string;
  /** Epoch ms; the factories get SIGTERM at this instant, SIGKILL after termGraceMs. */
  readonly hardDeadlineMs: number;
  /** Epoch ms; every step after the runs ends by then. */
  readonly reportByMs: number;
  readonly repoRoot: string;
  readonly hiddenDir: string;
  readonly factoryCommand: readonly string[];
  readonly taskConcurrency: number;
  readonly termGraceMs: number;
  /** The only git the run may do: read-only listing calls, each bounded by `timeoutMs` when given. */
  readonly git: (args: readonly string[], cwd: string, timeoutMs?: number) => Promise<string>;
  /** One line of live output. */
  readonly write: (line: string) => void;
}

/** One checked step of one spec's row. */
export interface StepOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/** One line of the table: the factory, the delivery, the build, the ignore list and the startup of one spec. */
export interface HiddenRow {
  readonly name: string;
  /** `exit <code>` or `killed at the hard deadline`. */
  readonly factory: string;
  readonly delivered: boolean;
  /** Null when the report time passed before the step could start. */
  readonly build: StepOutcome | null;
  /** Null when the report time passed before the listing could finish. */
  readonly ignored: readonly string[] | null;
  /** Null when the report time passed before the step could start. */
  readonly startup: StepOutcome | null;
}

/** The timeout of one git listing call, in milliseconds. */
export const GIT_TIMEOUT_MS = 30_000;

/** The bound of one npm install, build or server wait is the earlier of these caps and the caller's deadline. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const BUILD_TIMEOUT_MS = 5 * 60_000;

/**
 * The parts of a delivery's package.json the hidden run reads: the bins, the
 * main file and the scripts. Zod at the boundary: the package is model-written code.
 */
const PackageManifest = z.looseObject({
  main: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});
export type PackageManifestType = z.infer<typeof PackageManifest>;

/** One spec's plan: the delivered-into directory and the unique spec copy the factory starts from. */
export interface SpecPlan {
  readonly name: string;
  readonly specPath: string;
  readonly copyPath: string;
  readonly outDir: string;
}

/** The local-time stamp `HHMMSS` of `now`, for the unique spec copy names. */
function hhmmss(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/** A parsed manifest, or the failed step that explains why there is none. */
export type ManifestRead =
  | { readonly ok: true; readonly manifest: PackageManifestType }
  | { readonly ok: false; readonly outcome: StepOutcome };

/** Reads `<dir>/package.json` through the schema; a missing, malformed or off-schema file is a failed step, never a throw. */
export function readManifest(dir: string, where: string): ManifestRead {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return { ok: false, outcome: { ok: false, detail: `no package.json in ${where}` } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      outcome: { ok: false, detail: `package.json is not JSON: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
  const parsed = PackageManifest.safeParse(raw);
  if (!parsed.success) return { ok: false, outcome: { ok: false, detail: `package.json: ${outputTail(parsed.error.message)}` } };
  return { ok: true, manifest: parsed.data };
}

/** One plan per spec: name from specNameFromFileName, a copy `<name>-<HHMMSS>.md` in scratchDir, outDir `<hiddenDir>/<name>`. Throws on a duplicate name or a non-empty outDir. */
export function planSpecs(specPaths: readonly string[], hiddenDir: string, scratchDir: string, now: Date): readonly SpecPlan[] {
  const plans: SpecPlan[] = [];
  const seen = new Set<string>();
  for (const specPath of specPaths) {
    const name = specNameFromFileName(specPath);
    if (seen.has(name)) throw new Error(`two specs share the name ${JSON.stringify(name)} (${specPath})`);
    seen.add(name);
    const outDir = join(hiddenDir, name);
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      throw new Error(`the output directory ${outDir} is not empty`);
    }
    const copyPath = join(scratchDir, `${name}-${hhmmss(now)}.md`);
    copyFileSync(specPath, copyPath);
    plans.push({ name, specPath, copyPath, outDir });
  }
  return plans;
}

/** base + ['run', copyPath, '--out', outDir, '--cutoff', cutoff, '--task-concurrency', String(n), '--deliver-unverified']. */
export function factoryArgv(base: readonly string[], plan: SpecPlan, cutoff: string, taskConcurrency: number): readonly string[] {
  return [
    ...base,
    'run',
    plan.copyPath,
    '--out',
    plan.outDir,
    '--cutoff',
    cutoff,
    '--task-concurrency',
    String(taskConcurrency),
    '--deliver-unverified',
  ];
}

/** Writes `<dir>/.gitignore` with the single line `node_modules/`. */
export function rewriteGitignore(dir: string): void {
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
}

/** Runs git read-only, throwing on a non-zero exit; the only git the run does. */
export const realGit = async (args: readonly string[], cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): Promise<string> => {
  const bound = Math.min(GIT_TIMEOUT_MS, timeoutMs);
  const outcome = await runCommand({ command: 'git', args: [...args], cwd, timeoutMs: bound, env: gitEnv(), secrets: [] });
  if (outcome.exitCode !== 0) {
    const detail = outputTail(`${outcome.stderr}\n${outcome.stdout}`);
    const exit = outcome.exitCode === null ? 'no exit' : String(outcome.exitCode);
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: exit ${exit}${detail === '' ? '' : `: ${detail}`}`);
  }
  return outcome.stdout;
};

/**
 * `git ls-files -z --cached --others --exclude-standard -- <dir>` from
 * repoRoot, as repo-relative paths, minus the tracked paths missing on disk
 * (an earlier delivery's file the new one lacks: `git add` stages its removal).
 */
export async function committableFiles(
  git: HiddenOptions['git'],
  repoRoot: string,
  dir: string,
  timeoutMs?: number,
): Promise<readonly string[]> {
  const out = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir], repoRoot, timeoutMs);
  return out.split('\0').filter((path) => path !== '' && existsSync(join(repoRoot, path)));
}

/** `git ls-files -z --others --ignored --exclude-standard -- <dir>`, paths under node_modules dropped. */
export async function ignoredFiles(
  git: HiddenOptions['git'],
  repoRoot: string,
  dir: string,
  timeoutMs?: number,
): Promise<readonly string[]> {
  const out = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', dir], repoRoot, timeoutMs);
  return out.split('\0').filter((path) => path !== '' && !path.split('/').includes('node_modules'));
}

/** Text flattened to one line. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The last characters of a command output, flattened to one line, for a row detail. */
export function outputTail(text: string): string {
  const flat = oneLine(text);
  return flat.length > 400 ? `... ${flat.slice(-400)}` : flat;
}

/** One failed command as a short reason. */
export function failedDetail(label: string, outcome: CommandOutcome): string {
  const code = outcome.exitCode === null ? 'no exit' : `exit ${String(outcome.exitCode)}`;
  const cause = outcome.spawnFailure === null ? (outcome.timedOut ? ' after the timeout' : '') : ` (${outcome.spawnFailure})`;
  const tail = outputTail(`${outcome.stdout} ${outcome.stderr}`);
  return `${label}: ${code}${cause}${tail === '' ? '' : `: ${tail}`}`;
}

/** True for the temp entries the copies and the copy-back always leave out. */
function notDeliveryEntry(path: string): boolean {
  return !['node_modules', '.git'].includes(basename(path));
}

/**
 * Copy of dir without node_modules and .git to a temp dir, `npm install --ignore-scripts`, `npm run build` when package.json has a build script, then every file copied back except node_modules and .git. No build script: ok, detail "no build script".
 */
export async function buildInPlace(dir: string, deadlineMs: number): Promise<StepOutcome> {
  const copyDir = mkdtempSync(join(tmpdir(), 'factory-hidden-build-'));
  try {
    cpSync(dir, copyDir, { recursive: true, filter: notDeliveryEntry });
    const manifest = readManifest(copyDir, 'the delivery');
    if (!manifest.ok) return manifest.outcome;
    return await withScratchHome(async (home) => {
      const env = nodeOnlyEnv(home, { NO_COLOR: '1', FORCE_COLOR: '0' });
      const install = await runCommand({
        command: 'npm',
        args: ['install', '--ignore-scripts'],
        cwd: copyDir,
        timeoutMs: Math.min(INSTALL_TIMEOUT_MS, deadlineMs - Date.now()),
        env,
        secrets: [],
        stdin: '',
      });
      if (install.exitCode !== 0 || install.timedOut) return { ok: false, detail: failedDetail('npm install', install) };
      if (manifest.manifest.scripts?.['build'] === undefined) return { ok: true, detail: 'no build script' };
      const build = await runCommand({
        command: 'npm',
        args: ['run', 'build'],
        cwd: copyDir,
        timeoutMs: Math.min(BUILD_TIMEOUT_MS, deadlineMs - Date.now()),
        env,
        secrets: [],
        stdin: '',
      });
      if (build.exitCode !== 0 || build.timedOut) return { ok: false, detail: failedDetail('npm run build', build) };
      try {
        cpSync(copyDir, dir, { recursive: true, filter: notDeliveryEntry });
      } catch (error) {
        return { ok: false, detail: `copy back: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: true, detail: 'built in a copy and copied back' };
    });
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
}

/** The cell of a step or listing the report time cut off. */
const NOT_CHECKED = 'not checked: report time';

/** One line of the table, cells padded to the column width, last column unpadded. */
function tableLine(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => (index < cells.length - 1 ? cell.padEnd(widths[index] ?? 0) : cell)).join('  ');
}

/**
 * One line per row over a padded grid: name, factory, delivered, ignored
 * count, build and startup; a null step or listing reads "not checked:
 * report time". Detail cells are flattened to one line and capped, so a row never
 * spans several lines; a cell keeps the head of the detail (the step and
 * the error name), the full detail is printed under the table.
 */
export function renderTable(rows: readonly HiddenRow[]): string {
  const header = ['name', 'factory', 'delivered', 'ignored', 'build', 'startup'];
  const step = (outcome: StepOutcome | null): string =>
    outcome === null ? NOT_CHECKED : `${outcome.ok ? 'ok' : 'failed'}: ${oneLine(outcome.detail).slice(0, 120)}`;
  const grid = rows.map((row) => [
    row.name,
    row.factory,
    row.delivered ? 'yes' : 'no',
    row.ignored === null ? NOT_CHECKED : String(row.ignored.length),
    step(row.build),
    step(row.startup),
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...grid.map((cells) => (cells[index] ?? '').length)));
  return [tableLine(header, widths), ...grid.map((cells) => tableLine(cells, widths))].join('\n');
}

/** The owner's steps: review the table, `git add hidden/`, commit, push, check the remote commit lists every hidden/<name>/. */
export const OWNER_STEPS = [
  'Owner steps:',
  '1. Review the table above.',
  '2. git add hidden/',
  '3. Commit and push.',
  '4. Check the remote commit lists every hidden/<name>/ file.',
].join('\n');
