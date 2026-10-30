#!/usr/bin/env bun
/**
 * CLI layer: the `factory` command and the composition root, the only place
 * that picks adapters and wires them into the application. It parses the
 * command line, dispatches `run`, `report`, `intervene` and `doctor`, and
 * turns their outcome into the exit code (2 for a usage error, including a
 * run id that is not one safe directory name, a spec that is empty, not a
 * file or not named as a slug, and an `--out` the factory did not create;
 * a failed report write keeps the run's own code). The
 * factory's files (`config/`, `runs/`, `work/`, `out/`, `.apb/`) live under
 * the repository root this module sits in. No command process group
 * outlives the CLI process.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { killLiveProcessGroups } from '../adapters/check-runner/process';
import { systemClock } from '../adapters/index';
import { RUN_ID_PATTERN } from '../adapters/trace-fs/read';
import { FileRunStore } from '../adapters/trace-fs/store';
import { deliveryTargetProblem } from '../adapters/workspace-git/git-workspace';
import { messageOf } from '../adapters/mcp-stdio/errors';
import { RunFactory } from '../application/index';
import { resolveRunLimits, RunOptionsSchema } from '../domain/limits';
import { makeSpec, type Spec } from '../domain/spec';
import { type Command, parseArgs, USAGE, UsageError } from './args';
import { compose, envSecrets, type Env } from './compose';
import { filterMozaikWarning } from './console-filter';
import { runDoctor } from './doctor';
import { doctorChecks } from './doctor-checks';
import { EXIT, newRunId, runCommand } from './run';
import { interveneCommand, reportCommand, writeRunReport } from './run-records';

/** The repository root: the factory's own files live here. */
const ROOT = resolve(import.meta.dir, '..', '..');

/** What the CLI talks to; the process in production. */
export interface CliIo {
  readonly env: Env;
  readonly write: (line: string) => void;
  readonly exit: (code: number) => void;
}

/** Reads and validates the spec file; a problem is one line for a usage error. */
async function readSpec(specPath: string): Promise<Spec | string> {
  try {
    if (!statSync(specPath).isFile()) return `invalid spec: ${specPath} is not a file`;
    return makeSpec({ markdown: await Bun.file(specPath).text(), sourceFile: specPath });
  } catch (error) {
    const detail = error instanceof z.ZodError ? 'the file is empty or its name is not a lowercase slug' : messageOf(error);
    return `invalid spec: ${specPath}: ${detail}`;
  }
}

async function run(command: Extract<Command, { name: 'run' }>, io: CliIo): Promise<number> {
  const specPath = resolve(command.specPath);
  if (!existsSync(specPath)) {
    io.write(`spec file not found: ${command.specPath}`);
    return EXIT.usage;
  }
  const spec = await readSpec(specPath);
  if (typeof spec === 'string') {
    io.write(spec);
    return EXIT.usage;
  }
  const outDir = resolve(command.outDir ?? join(ROOT, 'out', spec.name));
  const outProblem = deliveryTargetProblem(outDir);
  if (outProblem !== undefined) {
    io.write(`refused: ${outProblem}`);
    return EXIT.usage;
  }
  const base = {
    deliverUnverified: command.deliverUnverified,
    outDir,
    ...(command.runtimes === undefined ? {} : { requiredRuntimes: [...command.runtimes] }),
  };
  const limits = resolveRunLimits(RunOptionsSchema.parse(base));
  const cutoff = new AbortController();
  let composition;
  try {
    composition = compose(ROOT, io.env, io.write, { replanBudget: limits.runReplanBudget, cutoff: cutoff.signal });
  } catch (error) {
    io.write(`setup failed: ${messageOf(error)}`);
    return EXIT.failed;
  }
  try {
    const runId = newRunId(spec.name, systemClock.now());
    const result = await runCommand(
      {
        // The keys come from the environment on every start and are never saved with the run.
        factory: new RunFactory(composition.ports, { secrets: composition.secrets }),
        signals: process,
        cutoff,
        write: io.write,
        exit: io.exit,
      },
      { runId, spec, options: base },
    );
    try {
      const file = await writeRunReport(ROOT, result.runId, io.write);
      if (file !== null) io.write(`report: ${file}`);
    } catch (error) {
      // The run's own outcome decides the exit code; a report failure is only reported.
      io.write(`report failed: ${messageOf(error)}`);
    }
    return result.code;
  } finally {
    await composition.close();
  }
}

/** Runs the command in `argv` (the arguments after the program) and returns the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.write(`${error.message}\n${USAGE}`);
    return EXIT.usage;
  }
  if ((command.name === 'report' || command.name === 'intervene') && !RUN_ID_PATTERN.test(command.runId)) {
    io.write(`refused: the run id is not a safe directory name: ${JSON.stringify(command.runId)}`);
    return EXIT.usage;
  }
  switch (command.name) {
    case 'run':
      return run(command, io);
    case 'report':
      return reportCommand(ROOT, command.runId, io.write);
    case 'intervene': {
      const store = new FileRunStore(ROOT, systemClock);
      store.setSecrets(envSecrets(io.env));
      return interveneCommand({
        root: ROOT,
        store,
        runId: command.runId,
        note: command.note,
        write: io.write,
      });
    }
    case 'doctor':
      return runDoctor(doctorChecks(ROOT, io.env), io.write);
  }
}

if (import.meta.main) {
  filterMozaikWarning(console);
  process.on('exit', killLiveProcessGroups);
  const exit = (code: number): void => process.exit(code);
  process.exit(await main(process.argv.slice(2), { env: process.env, write: (line) => console.log(line), exit }));
}
