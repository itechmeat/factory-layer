/**
 * Independent verification of a delivered package, without the factory:
 * each runtime gets its own clean copy of the delivered directory (no
 * `node_modules`, no `.git`), installs it without lifecycle scripts,
 * builds it when it has a build script and runs its tests, and the spec
 * examples run against the package's `bin` under Node in the npm copy (the
 * command name preferring one of the bin names the package declares).
 * Every step is a bounded child process with the same allowlisted
 * environment and scratch HOME the factory gives generated code; a failing
 * step is a recorded result with its output tail, never an exception.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';

import { generatedCodeEnv, withScratchHome } from '../src/adapters/child-env';
import { commandNameOf, compareExample, toNodeCommand, type SpecExample } from './e2e-examples';
import { runBeforeDeadline, tail, type Deadline } from './e2e-process';

/** Timeout of one install, in milliseconds. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Timeout of one test run, in milliseconds. */
export const TEST_TIMEOUT_MS = 10 * 60_000;

/** Timeout of the build that produces a missing `bin` file, in milliseconds. */
export const BUILD_TIMEOUT_MS = 5 * 60_000;

/** Timeout of one spec example, in milliseconds. */
export const EXAMPLE_TIMEOUT_MS = 30_000;

/** The runtimes the delivered package must pass under. */
export const RUNTIMES = ['bun', 'npm'] as const;
export type Runtime = (typeof RUNTIMES)[number];

const PackageJsonSchema = z.looseObject({
  name: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});
type PackageJson = z.infer<typeof PackageJsonSchema>;

/** One step of a verification, with the tail of its output. */
export interface StepResult {
  readonly name: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputTail: string;
}

/** The verification under one runtime. */
export interface RuntimeResult {
  readonly runtime: Runtime;
  readonly passed: boolean;
  readonly copyDir: string;
  readonly steps: readonly StepResult[];
}

/** One spec example against the delivered CLI. */
export interface ExampleResult {
  readonly command: string;
  readonly mismatch: string | null;
}

/** Copy `source` to a fresh temporary directory, leaving out `node_modules` and `.git`. */
export function cleanCopy(source: string, label: string): string {
  const target = mkdtempSync(join(tmpdir(), `factory-e2e-${label}-`));
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !['node_modules', '.git'].includes(basename(path)),
  });
  return target;
}

function readPackage(dir: string): PackageJson | string {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return 'no package.json';
  try {
    const parsed = PackageJsonSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : `package.json: ${parsed.error.message}`;
  } catch (error) {
    return `package.json: ${String(error)}`;
  }
}

/** Environment of the verification steps: the generated-code allowlist, no colour codes. */
function stepEnv(home: string): Readonly<Record<string, string>> {
  return generatedCodeEnv(home, { NO_COLOR: '1', FORCE_COLOR: '0' });
}

async function step(
  name: string,
  argv: readonly [string, ...string[]],
  where: { readonly cwd: string; readonly home: string },
  timeoutMs: number,
  deadline: Deadline,
): Promise<StepResult> {
  const [command, ...args] = argv;
  const result = await runBeforeDeadline({ command, args, cwd: where.cwd, timeoutMs, env: stepEnv(where.home) }, deadline);
  return {
    name,
    passed: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.elapsedMs,
    outputTail: tail(`${result.stdout}\n${result.stderr}${result.spawnFailure ?? ''}`),
  };
}

/** Install the delivered package in a clean copy and run its tests under one runtime. */
export async function verifyRuntime(runtime: Runtime, delivered: string, deadline: Deadline): Promise<RuntimeResult> {
  const copyDir = cleanCopy(delivered, runtime);
  const pkg = readPackage(copyDir);
  if (typeof pkg === 'string') {
    const failed: StepResult = { name: 'package.json', passed: false, exitCode: null, timedOut: false, durationMs: 0, outputTail: pkg };
    return { runtime, passed: false, copyDir, steps: [failed] };
  }
  const hasTestScript = pkg.scripts?.['test'] !== undefined;
  const steps = await withScratchHome(async (home) => {
    const where = { cwd: copyDir, home };
    const done = [await step(`${runtime} install`, [runtime, 'install', '--ignore-scripts'], where, INSTALL_TIMEOUT_MS, deadline)];
    if (done.every((s) => s.passed) && pkg.scripts?.['build'] !== undefined) {
      done.push(await step(`${runtime} run build`, [runtime, 'run', 'build'], where, BUILD_TIMEOUT_MS, deadline));
    }
    if (done.every((s) => s.passed)) {
      const testArgv: [string, ...string[]] =
        runtime === 'npm' ? ['npm', 'test'] : hasTestScript ? ['bun', 'run', 'test'] : ['bun', 'test'];
      done.push(await step(testArgv.join(' '), testArgv, where, TEST_TIMEOUT_MS, deadline));
    }
    return done;
  });
  return { runtime, passed: steps.every((s) => s.passed), copyDir, steps };
}

function binPath(pkg: PackageJson, commandName: string): string | undefined {
  if (typeof pkg.bin === 'string') return pkg.name === commandName ? pkg.bin : undefined;
  return pkg.bin?.[commandName];
}

/** The command names the package's `bin` declares: its keys, or the package name for a single bin path. */
function binNamesOf(pkg: PackageJson): readonly string[] {
  if (typeof pkg.bin === 'string') return pkg.name === undefined ? [] : [pkg.name];
  return Object.keys(pkg.bin ?? {});
}

/** Resolve the CLI file of `commandName` in an installed copy, building it once when it is missing. */
async function resolveBin(
  where: { readonly cwd: string; readonly home: string },
  commandName: string,
  deadline: Deadline,
): Promise<string> {
  const dir = where.cwd;
  const pkg = readPackage(dir);
  if (typeof pkg === 'string') throw new Error(pkg);
  const relative = binPath(pkg, commandName);
  if (relative === undefined) throw new Error(`package.json has no bin named ${commandName}`);
  const absolute = resolve(dir, relative);
  if (existsSync(absolute)) return absolute;
  if (pkg.scripts?.['build'] === undefined) throw new Error(`bin file ${relative} is missing and there is no build script`);
  const build = await step('npm run build', ['npm', 'run', 'build'], where, BUILD_TIMEOUT_MS, deadline);
  if (!build.passed || !existsSync(absolute)) throw new Error(`bin file ${relative} is missing after npm run build:\n${build.outputTail}`);
  return absolute;
}

/**
 * Run every spec example under Node in an installed copy and compare it with
 * the spec. The command is the examples' command that is one of the
 * package's bin names, else `specCommandName` (chosen from the spec alone).
 */
export async function runExamples(
  dir: string,
  examples: readonly SpecExample[],
  specCommandName: string,
  deadline: Deadline,
): Promise<readonly ExampleResult[]> {
  const pkg = readPackage(dir);
  const commandName = (typeof pkg === 'string' ? undefined : commandNameOf(examples, binNamesOf(pkg))) ?? specCommandName;
  return withScratchHome(async (home) => {
    let bin: string;
    try {
      bin = await resolveBin({ cwd: dir, home }, commandName, deadline);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return examples.map((example) => ({ command: example.command, mismatch: reason }));
    }
    const results: ExampleResult[] = [];
    for (const example of examples) {
      const shell = toNodeCommand(example.command, commandName, bin);
      const run = await runBeforeDeadline(
        { command: 'bash', args: ['-c', shell], cwd: dir, timeoutMs: EXAMPLE_TIMEOUT_MS, env: stepEnv(home) },
        deadline,
      );
      results.push({ command: example.command, mismatch: compareExample(example, commandName, run) });
    }
    return results;
  });
}
