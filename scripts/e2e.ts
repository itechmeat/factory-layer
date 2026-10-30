/**
 * The end-to-end run (`bun run e2e [spec] [--deadline-min N] [--delivered <dir>]`),
 * the factory's main acceptance test. It runs `factory run` on the practice
 * spec (default `examples/specs/wordfreq.md`) under a spec name unique to
 * this run, then verifies the delivered package independently of the
 * factory: tests under `bun` and `npm` from clean copies, and the spec
 * examples under Node. It prints the outcome, the wall time, the per-task
 * time and cost from the run's report and the verification, and exits 0
 * only when the outcome is `succeeded`, both runtimes pass and every
 * example holds. `--delivered <dir>` skips the factory and verifies an
 * existing delivery, which then passes on the verification alone.
 *
 * The spec examples are read and validated before the factory starts, and
 * the command they invoke is taken from them. The `run id:` and `report:`
 * lines are captured apart from the kept tail of the output, so a long run
 * still finds its report. The first Ctrl-C (SIGINT or SIGTERM) is forwarded
 * to the factory, which takes its cutoff path; a second kills every child.
 *
 * Invariant: the whole script ends by its absolute deadline (default two
 * hours); every child is bounded by it (the factory's term grace included)
 * and killed with its process group, and a watchdog kills whatever is still
 * running when it expires.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import { commandNameOf, parseExamples } from './e2e-examples';
import { killLiveProcessGroups } from '../src/adapters/check-runner/process';
import { createDeadline, remainingMs, runBeforeDeadline, type Deadline } from './e2e-process';
import { formatSummary, parseOutcome, parseReport, parseRunId, type FactoryReport } from './e2e-report';
import { RUNTIMES, runExamples, verifyRuntime, type ExampleResult, type RuntimeResult } from './e2e-verify';

/** The repository root: `factory run` runs here and writes `runs/` and `out/` here. */
const REPO_ROOT = join(import.meta.dir, '..');

/** The practice spec run when none is given. */
export const DEFAULT_SPEC = 'examples/specs/wordfreq.md';

/** Default absolute deadline of the whole script, in minutes. */
export const DEFAULT_DEADLINE_MIN = 120;

/** Time kept back from the factory for the verification, in milliseconds, at most a quarter of what is left. */
export const VERIFY_RESERVE_MS = 20 * 60_000;

/** Wait between SIGTERM to `factory run` (its cutoff path) and SIGKILL to its group, in milliseconds. */
export const FACTORY_GRACE_MS = 5 * 60_000;

/** The factory output kept for parsing, in characters: its last part, where the outcome is printed. */
const FACTORY_OUTPUT_KEEP_CHARS = 1_000_000;

/** The term grace of the factory: at most half the time kept after its timeout, so it never runs past the deadline. */
export function factoryGraceMs(reserveMs: number): number {
  return Math.min(FACTORY_GRACE_MS, reserveMs / 2);
}

/** The kept tail of the factory output plus every `run id:` and `report:` line, wherever they were printed. */
export class OutputCapture {
  readonly #keepChars: number;
  #tail = '';
  #carry = '';
  readonly #marks: string[] = [];

  constructor(keepChars: number) {
    this.#keepChars = keepChars;
  }

  add(text: string): void {
    this.#tail = (this.#tail + text).slice(-this.#keepChars);
    const lines = (this.#carry + text).split('\n');
    // A partial line waits for its end; only its start can be a mark, so a long one is cut.
    this.#carry = (lines.pop() ?? '').slice(0, 4096);
    for (const line of lines) if (/^(run id|report):/.test(line)) this.#marks.push(line);
  }

  text(): string {
    return [...this.#marks, this.#tail].join('\n');
  }
}

/** The pid of the running factory, so the first Ctrl-C reaches it. */
let factoryPid: number | undefined;

/** The factory's own environment: it needs the provider keys, so it inherits the script's environment. */
function factoryEnv(): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

const Args = z.object({
  spec: z.string().min(1),
  deadlineMin: z.coerce.number().positive(),
  delivered: z.string().min(1).optional(),
});

/** What the factory run left behind. */
interface FactoryRun {
  readonly specName: string;
  readonly outDir: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly cliOutput: string;
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * The only place that knows how the factory is started: `factory run` on a
 * copy of the spec named `<name>-<timestamp>.md` (so earlier work
 * repositories and output directories are never reused), into a fresh
 * output directory, bounded by the deadline minus the verification reserve.
 */
async function runFactory(specPath: string, deadline: Deadline): Promise<FactoryRun> {
  const specName = `${basename(specPath, '.md')}-${stamp()}`;
  const specCopy = join(mkdtempSync(join(tmpdir(), 'factory-e2e-spec-')), `${specName}.md`);
  copyFileSync(specPath, specCopy);
  const outDir = join(REPO_ROOT, 'out', 'e2e', specName);
  mkdirSync(join(REPO_ROOT, 'out', 'e2e'), { recursive: true });
  console.log(`e2e: factory run ${specCopy} --out ${outDir}`);
  const capture = new OutputCapture(FACTORY_OUTPUT_KEEP_CHARS);
  const reserveMs = Math.min(VERIFY_RESERVE_MS, remainingMs(deadline) / 4);
  const result = await runBeforeDeadline(
    {
      command: 'bun',
      args: ['run', 'src/cli/index.ts', 'run', specCopy, '--out', outDir],
      cwd: REPO_ROOT,
      env: factoryEnv(),
      timeoutMs: remainingMs(deadline) - reserveMs,
      termGraceMs: factoryGraceMs(reserveMs),
      onStart: (pid) => {
        factoryPid = pid;
      },
      onOutput: (chunk, stream) => {
        (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
        capture.add(chunk.toString('utf8'));
      },
    },
    deadline,
  );
  factoryPid = undefined;
  const cliOutput = capture.text();
  return {
    specName,
    outDir,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.elapsedMs,
    cliOutput,
  };
}

function readReport(runId: string | undefined): FactoryReport | undefined {
  if (runId === undefined) return undefined;
  const path = join(REPO_ROOT, 'runs', runId, 'report.md');
  return existsSync(path) ? parseReport(readFileSync(path, 'utf8')) : undefined;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { 'deadline-min': { type: 'string' }, delivered: { type: 'string' } },
    allowPositionals: true,
  });
  const args = Args.parse({
    spec: positionals[0] ?? DEFAULT_SPEC,
    deadlineMin: values['deadline-min'] ?? DEFAULT_DEADLINE_MIN,
    delivered: values.delivered,
  });
  const deadline = createDeadline(args.deadlineMin * 60_000);
  const watchdog = setTimeout(() => {
    console.error(`e2e: absolute deadline of ${args.deadlineMin} min reached; killing every child`);
    killLiveProcessGroups();
    process.exit(1);
  }, remainingMs(deadline));
  let signals = 0;
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.on(name, () => {
      signals += 1;
      if (signals === 1 && factoryPid !== undefined) {
        console.error(`e2e: ${name}; forwarding SIGINT to the factory (cutoff path); a second signal kills every child`);
        process.kill(factoryPid, 'SIGINT');
        return;
      }
      console.error(`e2e: ${name}; killing every child`);
      killLiveProcessGroups();
      process.exit(130);
    });
  }

  const specPath = resolve(args.spec);
  const parsed = parseExamples(readFileSync(specPath, 'utf8'));
  const examples = parsed.ok ? parsed.examples : [];
  const commandName = commandNameOf(examples);
  if (!parsed.ok || commandName === undefined) {
    // Checked before the factory starts: a run whose examples cannot be verified would be spent for nothing.
    console.error(`e2e: the spec examples cannot be verified: ${parsed.ok ? 'no example command' : parsed.error}`);
    clearTimeout(watchdog);
    return 2;
  }
  const notes: string[] = [];

  let factory: FactoryRun | undefined;
  if (args.delivered === undefined) factory = await runFactory(specPath, deadline);
  const runId = factory === undefined ? undefined : parseRunId(factory.cliOutput);
  const report = readReport(runId);
  if (factory !== undefined) {
    notes.push(`factory exit code ${factory.exitCode ?? 'none (killed)'}`);
    if (factory.timedOut) notes.push('factory run stopped by the deadline');
    if (runId === undefined) notes.push('no `run id:` line in the factory output');
    else if (report === undefined) notes.push(`no report at runs/${runId}/report.md`);
  }
  const delivered = args.delivered === undefined ? factory?.outDir : resolve(args.delivered);
  const outcome = factory === undefined ? 'not run (--delivered)' : (report?.outcome ?? parseOutcome(factory.cliOutput) ?? 'unknown');

  const runtimes: RuntimeResult[] = [];
  let exampleResults: readonly ExampleResult[] = [];
  if (delivered === undefined || !existsSync(join(delivered, 'package.json'))) {
    notes.push(`no delivered package at ${delivered ?? 'unknown'}`);
  } else {
    for (const runtime of RUNTIMES) runtimes.push(await verifyRuntime(runtime, delivered, deadline));
    const npmCopy = runtimes.find((r) => r.runtime === 'npm')?.copyDir;
    if (npmCopy !== undefined) exampleResults = await runExamples(npmCopy, examples, commandName, deadline);
  }

  const verified =
    runtimes.length === RUNTIMES.length &&
    runtimes.every((r) => r.passed) &&
    examples.length > 0 &&
    exampleResults.length === examples.length &&
    exampleResults.every((e) => e.mismatch === null);
  const passed = verified && (factory === undefined || outcome === 'succeeded');
  console.log(
    formatSummary({
      specName: factory?.specName ?? commandName,
      runId,
      outcome,
      factoryWallMs: factory?.durationMs,
      report,
      runtimes,
      examples: exampleResults,
      examplesError: undefined,
      notes,
      passed,
    }),
  );
  clearTimeout(watchdog);
  return passed ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
