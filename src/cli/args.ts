/**
 * The `factory` command line: parsing argv into one typed command, or a
 * usage error naming what is wrong. Commands: `run <spec.md> [--out <dir>]
 * [--runtimes bun,npm] [--deliver-unverified] [--cutoff <time>]
 * [--task-concurrency <n>]`, `report <runId>`, `intervene <runId> <note>`,
 * `author <kind> --example <file>`, `doctor`. Runtimes are validated with the domain's schema, the cutoff
 * with `parseClockTime` against the given `now` (a time not after it is a
 * usage error); nothing here touches the disk.
 */

import { z } from 'zod';

import { parseClockTime } from '../domain/clock-time';
import { type Runtime, RuntimeSchema } from '../domain/limits';

/** One parsed command. */
export type Command =
  | {
      readonly name: 'run';
      readonly specPath: string;
      readonly outDir: string | undefined;
      readonly runtimes: readonly Runtime[] | undefined;
      readonly deliverUnverified: boolean;
      /** The absolute cutoff, epoch ms; undefined when none was given. */
      readonly cutoffAtMs: number | undefined;
      /** The run's limit of task runs at the same time; undefined for the default. */
      readonly taskConcurrency: number | undefined;
    }
  | { readonly name: 'report'; readonly runId: string }
  | { readonly name: 'intervene'; readonly runId: string; readonly note: string }
  | { readonly name: 'author'; readonly taskKind: string; readonly examplePath: string }
  | { readonly name: 'doctor' };

/** The command line is wrong; the message says how. */
export class UsageError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'UsageError';
  }
}

/** The usage text printed with a usage error. */
export const USAGE = [
  'usage:',
  '  factory run <spec.md> [--out <dir>] [--runtimes bun,npm] [--deliver-unverified]',
  '              [--cutoff <HH:MM | ISO 8601 with zone>] [--task-concurrency <n>]',
  '  factory report <runId>',
  '  factory intervene <runId> <note>',
  '  factory author <kind> --example <file>',
  '  factory doctor',
].join('\n');

const RuntimesSchema = z.array(RuntimeSchema).min(1);

function parseRuntimes(value: string): readonly Runtime[] {
  const parsed = RuntimesSchema.safeParse(value.split(',').map((part) => part.trim()));
  if (!parsed.success) throw new UsageError(`--runtimes takes a comma-separated list of bun and npm, got "${value}"`);
  return [...new Set(parsed.data)];
}

function parseCutoff(value: string, now: Date): number {
  try {
    return parseClockTime(value, now);
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(`--cutoff: ${error.message}`);
    throw error;
  }
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function parseTaskConcurrency(value: string): number {
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value)))
    throw new UsageError(`--task-concurrency takes a positive integer, got "${value}"`);
  return Number(value);
}

function parseRun(args: readonly string[], now: Date): Command {
  const positional: string[] = [];
  let outDir: string | undefined;
  let runtimes: readonly Runtime[] | undefined;
  let deliverUnverified = false;
  let cutoffAtMs: number | undefined;
  let taskConcurrency: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === '--out') outDir = value();
    else if (arg === '--runtimes') runtimes = parseRuntimes(value());
    else if (arg === '--deliver-unverified') deliverUnverified = true;
    else if (arg === '--cutoff') cutoffAtMs = parseCutoff(value(), now);
    else if (arg === '--task-concurrency') taskConcurrency = parseTaskConcurrency(value());
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [specPath, ...extra] = positional;
  if (specPath === undefined) throw new UsageError('run needs the spec file');
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0] ?? ''}`);
  return { name: 'run', specPath, outDir, runtimes, deliverUnverified, cutoffAtMs, taskConcurrency };
}

function exactly(command: string, args: readonly string[], names: readonly string[]): readonly string[] {
  if (args.length !== names.length)
    throw new UsageError(`${command} takes ${names.map((name) => `<${name}>`).join(' ') || 'no arguments'}`);
  return args;
}

/** Parses the arguments after the program name, clock times against `now`; throws `UsageError`. */
export function parseArgs(argv: readonly string[], now: Date = new Date()): Command {
  const [command, ...args] = argv;
  switch (command) {
    case 'run':
      return parseRun(args, now);
    case 'report': {
      const [runId = ''] = exactly('report', args, ['runId']);
      return { name: 'report', runId };
    }
    case 'intervene': {
      const [runId = '', note = ''] = exactly('intervene', args, ['runId', 'note']);
      if (note.trim() === '') throw new UsageError('intervene needs a non-empty note');
      return { name: 'intervene', runId, note };
    }
    case 'author': {
      const [taskKind = '', flag = '', examplePath = ''] = exactly('author', args, ['kind', '--example', 'file']);
      if (flag !== '--example') throw new UsageError('author takes <kind> --example <file>');
      return { name: 'author', taskKind, examplePath };
    }
    case 'doctor':
      exactly('doctor', args, []);
      return { name: 'doctor' };
    case undefined:
      throw new UsageError('no command given');
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}
