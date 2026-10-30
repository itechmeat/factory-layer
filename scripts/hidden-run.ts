/**
 * The hidden run (`bun run scripts/hidden-run.ts <spec.md>...`): one
 * `factory run` per hidden spec, all started at once and bounded by a hard
 * deadline, then each delivery is made committable (`.gitignore` with
 * `node_modules/`, built files copied back) and checked (ignored files,
 * startup on exactly the committable files), all by the report time; the
 * table and the owner's steps are printed. A non-empty hidden/<name> is
 * refused unless `--replace` is given and it holds the factory's delivery
 * marker; then it is removed first. Invariant: the script changes
 * nothing in git and every wait is bounded by the hard deadline or the
 * report time, whatever the factories and the delivered packages do.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import { killLiveProcessGroups, runCommand } from '../src/adapters/check-runner/process';
import type { CommandOutcome } from '../src/ports/check-runner';
import { parseClockTime } from '../src/domain/clock-time';
import { startupCheck } from './hidden-run-startup';
import {
  OWNER_STEPS,
  buildInPlace,
  committableFiles,
  factoryArgv,
  ignoredFiles,
  planSpecs,
  realGit,
  renderTable,
  rewriteGitignore,
  type HiddenOptions,
  type HiddenRow,
  type SpecPlan,
} from './hidden-run-steps';

/** The default command line options, all configurable. */
const DEFAULT_CUTOFF = '19:15';
const DEFAULT_HARD_DEADLINE = '19:22';
const DEFAULT_REPORT_BY = '19:26';
const DEFAULT_TASK_CONCURRENCY = 2;
/** The SIGTERM-to-SIGKILL grace of a factory killed at the hard deadline, in milliseconds. */
const DEFAULT_TERM_GRACE_MS = 30_000;

/** The repository root: `factory run` runs here and writes `hidden/` here. */
const REPO_ROOT = join(import.meta.dir, '..');

/** The environment of the factories: the script's own, string values only (the factory needs the provider keys; it is not generated code). */
function scriptEnv(): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Prefixes every complete line of one factory's output with its spec name. */
class LinePrefixer {
  private readonly prefix: string;
  private readonly write: (line: string) => void;
  private carry = '';

  constructor(prefix: string, write: (line: string) => void) {
    this.prefix = prefix;
    this.write = write;
  }

  add(text: string): void {
    const lines = (this.carry + text).split('\n');
    this.carry = lines.pop() ?? '';
    for (const line of lines) this.write(`${this.prefix}${line}`);
  }

  flush(): void {
    if (this.carry !== '') {
      this.write(`${this.prefix}${this.carry}`);
      this.carry = '';
    }
  }
}

/** The leader pids of the factories still running, for the Ctrl-C forwarding of the CLI. */
const liveFactoryPids = new Set<number>();

/** Starts one factory for its spec copy and prefixes its live output, one prefixer per stream so partial lines never mix. */
async function runFactory(options: HiddenOptions, plan: SpecPlan): Promise<CommandOutcome> {
  if (options.factoryCommand.length === 0) throw new Error('factoryCommand is empty');
  const [command, ...args] = factoryArgv(options.factoryCommand, plan, options.cutoff, options.taskConcurrency);
  const prefixers = {
    stdout: new LinePrefixer(`[${plan.name}] `, options.write),
    stderr: new LinePrefixer(`[${plan.name}] `, options.write),
  };
  let pid: number | undefined;
  const outcome = await runCommand({
    command: command ?? '',
    args,
    cwd: options.repoRoot,
    timeoutMs: Math.max(0, options.hardDeadlineMs - Date.now()),
    env: scriptEnv(),
    secrets: [],
    // The kill after the grace never pushes the table past the report time.
    termGraceMs: Math.min(options.termGraceMs, Math.max(0, options.reportByMs - options.hardDeadlineMs)),
    onStart: (started) => {
      pid = started;
      liveFactoryPids.add(started);
    },
    onOutput: (chunk, stream) => prefixers[stream].add(chunk.toString('utf8')),
  });
  if (pid !== undefined) liveFactoryPids.delete(pid);
  prefixers.stdout.flush();
  prefixers.stderr.flush();
  return outcome;
}

/** The factory cell of a row: killed at the hard deadline, a spawn failure, or the exit code. */
export function factoryCell(outcome: CommandOutcome): string {
  if (outcome.timedOut) return 'killed at the hard deadline';
  if (outcome.spawnFailure !== null) return outcome.spawnFailure;
  return `exit ${String(outcome.exitCode)}`;
}

/** The git pathspec of one delivery: the delivery directory relative to the repo root. */
function gitPathOf(options: HiddenOptions, plan: SpecPlan): string {
  return relative(options.repoRoot, plan.outDir);
}

/**
 * Runs one post-build step with the time left until the report time as its
 * bound; null when no time is left, or when the step failed because the
 * report time passed meanwhile.
 */
async function beforeReport<T>(options: HiddenOptions, step: (boundMs: number) => Promise<T>): Promise<T | null> {
  const left = options.reportByMs - Date.now();
  if (left <= 0) return null;
  try {
    return await step(left);
  } catch (error) {
    if (Date.now() >= options.reportByMs) return null;
    throw error;
  }
}

/** One row of the table: the factory outcome plus the five steps of one delivery, each bounded by the report time. */
async function rowFor(options: HiddenOptions, plan: SpecPlan, factory: CommandOutcome): Promise<HiddenRow> {
  const factoryText = factoryCell(factory);
  if (!existsSync(plan.outDir) || readdirSync(plan.outDir).length === 0) {
    return { name: plan.name, factory: factoryText, delivered: false, build: null, ignored: [], startup: null };
  }
  rewriteGitignore(plan.outDir);
  const dir = gitPathOf(options, plan);
  const build = await beforeReport(options, async () => buildInPlace(plan.outDir, options.reportByMs));
  const ignored = await beforeReport(options, async (boundMs) => ignoredFiles(options.git, options.repoRoot, dir, boundMs));
  const committed = await beforeReport(options, async (boundMs) => committableFiles(options.git, options.repoRoot, dir, boundMs));
  const startup =
    committed === null ? null : await beforeReport(options, async () => startupCheck(options.repoRoot, committed, options.reportByMs));
  for (const file of ignored ?? []) options.write(`[${plan.name}] ignored: ${file}`);
  return { name: plan.name, factory: factoryText, delivered: true, build, ignored, startup };
}

/** The full detail of every failed step, one line each, for the lines the table cells cut. */
export function failureDetails(rows: readonly HiddenRow[]): readonly string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.build !== null && !row.build.ok) lines.push(`[${row.name}] build failed: ${row.build.detail}`);
    if (row.startup !== null && !row.startup.ok) lines.push(`[${row.name}] startup failed: ${row.startup.detail}`);
  }
  return lines;
}

/** What one hidden run produced: one row per spec and the exit code. */
export interface HiddenResult {
  readonly rows: readonly HiddenRow[];
  readonly exitCode: 0 | 1;
}

/** One factory per spec at once, then the steps per delivery, the table and the owner's steps; exit code 0 only for a fully clean run. */
export async function runHidden(options: HiddenOptions): Promise<HiddenResult> {
  const now = Date.now();
  if (now >= options.hardDeadlineMs) {
    throw new Error(`the hard deadline (${new Date(options.hardDeadlineMs).toISOString()}) is not after now`);
  }
  if (options.hardDeadlineMs >= options.reportByMs) {
    throw new Error('the report time is not after the hard deadline');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'factory-hidden-specs-'));
  try {
    const plans = planSpecs(options.specPaths, options.hiddenDir, scratch, new Date(), options.replace);
    const factories = await Promise.all(plans.map((plan) => runFactory(options, plan)));
    const rows: HiddenRow[] = [];
    for (const [index, plan] of plans.entries()) {
      const factory = factories[index];
      if (factory === undefined) throw new Error(`no factory outcome for ${plan.name}`);
      rows.push(await rowFor(options, plan, factory));
    }
    options.write(renderTable(rows));
    for (const line of failureDetails(rows)) options.write(line);
    options.write(OWNER_STEPS);
    const clean = rows.every((row) => row.delivered && row.build?.ok === true && row.ignored?.length === 0 && row.startup?.ok === true);
    return { rows, exitCode: clean ? 0 : 1 };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const ArgsSchema = z.object({
  cutoff: z.string().min(1).default(DEFAULT_CUTOFF),
  'hard-deadline': z.string().min(1).default(DEFAULT_HARD_DEADLINE),
  'report-by': z.string().min(1).default(DEFAULT_REPORT_BY),
  'task-concurrency': z.coerce.number().int().positive().default(DEFAULT_TASK_CONCURRENCY),
});

/** The three times of one run, as epoch ms. */
export interface HiddenTimes {
  readonly cutoffMs: number;
  readonly hardDeadlineMs: number;
  readonly reportByMs: number;
}

/** Parses the three times (`HH:MM` today or ISO 8601) and requires now < cutoff < hard deadline < report time. */
export function parseTimes(cutoff: string, hardDeadline: string, reportBy: string, now: Date): HiddenTimes {
  const times = {
    cutoffMs: parseClockTime(cutoff, now),
    hardDeadlineMs: parseClockTime(hardDeadline, now),
    reportByMs: parseClockTime(reportBy, now),
  };
  if (times.hardDeadlineMs <= times.cutoffMs) throw new RangeError(`the hard deadline ${hardDeadline} is not after the cutoff ${cutoff}`);
  if (times.reportByMs <= times.hardDeadlineMs)
    throw new RangeError(`the report time ${reportBy} is not after the hard deadline ${hardDeadline}`);
  return times;
}

/** Where the process signals come from; `process` in the CLI. */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** What the signal handler does: forward SIGINT to one factory, kill every group, exit. */
export interface InterruptActions {
  readonly forward: (pid: number) => void;
  readonly killAll: () => void;
  readonly exit: (code: number) => void;
  readonly write: (line: string) => void;
}

/**
 * The two-step Ctrl-C of the hidden run. The factories lead their own
 * process groups, so a terminal Ctrl-C never reaches them: the first signal
 * forwards SIGINT to every live factory (their cutoff path, they deliver and
 * exit, and the run goes on to the table); the second kills every group and
 * exits 130.
 */
export function installInterrupt(source: SignalSource, livePids: () => Iterable<number>, actions: InterruptActions): void {
  let received = 0;
  const onSignal = (): void => {
    received += 1;
    if (received === 1) {
      actions.write('hidden-run: signal received; forwarding SIGINT to every factory (cutoff path); a second signal kills every child');
      for (const pid of livePids()) actions.forward(pid);
      return;
    }
    actions.write('hidden-run: second signal; killing every child');
    actions.killAll();
    actions.exit(130);
  };
  source.on('SIGINT', onSignal);
  source.on('SIGTERM', onSignal);
}

/** The usage line printed for a bad command line. */
const USAGE =
  'usage: bun run hidden <spec.md>... [--cutoff HH:MM] [--hard-deadline HH:MM] [--report-by HH:MM] [--task-concurrency N] [--replace]';

/** Parses the command line or exits 2 on a bad one. */
async function cliMain(): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(process.argv.slice(2), new Date());
  } catch (error) {
    console.error(`hidden-run: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }
  installInterrupt(process, () => liveFactoryPids, {
    forward: (pid) => process.kill(pid, 'SIGINT'),
    killAll: killLiveProcessGroups,
    exit: (code) => process.exit(code),
    write: (line) => console.error(line),
  });
  try {
    const result = await runHidden({
      ...parsed,
      repoRoot: REPO_ROOT,
      hiddenDir: join(REPO_ROOT, 'hidden'),
      factoryCommand: ['bun', 'run', 'src/cli/index.ts'],
      termGraceMs: DEFAULT_TERM_GRACE_MS,
      git: realGit,
      write: (line) => console.log(line),
    });
    return result.exitCode;
  } catch (error) {
    console.error(`hidden-run: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** The command line as runHidden options; throws on a bad option, no spec, or a bad time order. */
export function parseCommandLine(
  argv: readonly string[],
  now: Date,
): Pick<HiddenOptions, 'specPaths' | 'cutoff' | 'hardDeadlineMs' | 'reportByMs' | 'taskConcurrency' | 'replace'> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      cutoff: { type: 'string' },
      'hard-deadline': { type: 'string' },
      'report-by': { type: 'string' },
      'task-concurrency': { type: 'string' },
      replace: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (positionals.length === 0) throw new Error('no spec given');
  const args = ArgsSchema.parse(values);
  const times = parseTimes(args.cutoff, args['hard-deadline'], args['report-by'], now);
  return {
    specPaths: positionals.map((path) => resolve(path)),
    cutoff: args.cutoff,
    hardDeadlineMs: times.hardDeadlineMs,
    reportByMs: times.reportByMs,
    taskConcurrency: args['task-concurrency'],
    replace: values.replace === true,
  };
}

if (import.meta.main) {
  const exitCode = await cliMain();
  killLiveProcessGroups();
  process.exit(exitCode);
}
