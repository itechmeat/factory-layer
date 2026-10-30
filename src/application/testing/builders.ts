/**
 * Deterministic fixture builders for tests: every id, path and instant is
 * stable (one fixed base instant, per-builder counters), so a test asserts
 * only what it overrides. Builders validate through the domain schemas.
 */

import {
  CliCheckSchema,
  CommandCheckSchema,
  HttpCheckSchema,
  PlanSchema,
  PlanTaskSchema,
  RunOptionsSchema,
  RunStateSchema,
  SpecSchema,
  type CliCheck,
  type CommandCheck,
  type HttpCheck,
  type Plan,
  type PlanTask,
  type RunState,
  type Spec,
  type TaskFailure,
} from '../../domain';
import type { ExecutorReport } from '../../ports';

import { FAKE_CLOCK_START_ISO } from './fake-clock';

let taskNumber = 0;

/** A plan task with a fresh id (`task-1`, `task-2`, ...); overrides win. */
export function aTask(overrides: Partial<PlanTask> = {}): PlanTask {
  taskNumber += 1;
  return PlanTaskSchema.parse({
    id: `task-${taskNumber}`,
    revision: 1,
    title: `Task ${taskNumber}`,
    description: `What task-${taskNumber} does.`,
    playbook: 'playbook-feature',
    ownedPaths: ['src'],
    dependsOn: [],
    ...overrides,
  });
}

/** A valid plan; defaults to one task, otherwise keeps the tasks given, in order. */
export function aPlan(tasks: readonly PlanTask[] = [aTask()]): Plan {
  return PlanSchema.parse({ tasks: [...tasks] });
}

/** The spec every fixture derives from; overrides win. */
export function aSpec(overrides: Partial<Spec> = {}): Spec {
  return SpecSchema.parse({
    name: 'todo-cli',
    markdown: '# todo-cli\n\nA small CLI that manages a todo list.',
    sourceFile: 'specs/todo-cli.md',
    ...overrides,
  });
}

let cliCheckNumber = 0;

/** A CLI acceptance check with a fresh id (`check-cli-1`, ...). */
export function cliCheck(overrides: Partial<CliCheck> = {}): CliCheck {
  cliCheckNumber += 1;
  return CliCheckSchema.parse({
    id: `check-cli-${cliCheckNumber}`,
    description: 'The CLI runs',
    kind: 'cli',
    args: ['--help'],
    expectedExitCode: 0,
    ...overrides,
  });
}

let httpCheckNumber = 0;

/** An HTTP acceptance check with a fresh id (`check-http-1`, ...). */
export function httpCheck(overrides: Partial<HttpCheck> = {}): HttpCheck {
  httpCheckNumber += 1;
  return HttpCheckSchema.parse({
    id: `check-http-${httpCheckNumber}`,
    description: 'The server answers',
    kind: 'http',
    method: 'GET',
    path: '/health',
    expectedStatus: 200,
    ...overrides,
  });
}

let commandCheckNumber = 0;

/** A command acceptance check with a fresh id (`check-command-1`, ...). */
export function commandCheck(overrides: Partial<CommandCheck> = {}): CommandCheck {
  commandCheckNumber += 1;
  return CommandCheckSchema.parse({
    id: `check-command-${commandCheckNumber}`,
    description: 'The command passes',
    kind: 'command',
    command: 'bun run check',
    expectedExitCode: 0,
    ...overrides,
  });
}

let runNumber = 0;

/** A valid RunState with run options filled in and one pending task; overrides win. */
export function aRunState(overrides: Partial<RunState> = {}): RunState {
  runNumber += 1;
  const task = aTask();
  return RunStateSchema.parse({
    schemaVersion: 1,
    runId: `run-${runNumber}`,
    spec: aSpec(),
    plan: aPlan(),
    acceptanceChecks: [],
    acceptanceUnavailable: false,
    options: RunOptionsSchema.parse({}),
    cutoffAtMs: null,
    replansUsed: 0,
    tasks: { [task.id]: { revision: task.revision, state: 'pending', attemptsUsed: 0 } },
    runs: {},
    intents: [],
    lastMainChecks: null,
    outcome: null,
    startedAt: FAKE_CLOCK_START_ISO,
    endedAt: null,
    ...overrides,
  });
}

/** The failure the brain and the trace see: a first attempt of node `code`. */
export function aTaskFailure(overrides: Partial<TaskFailure> = {}): TaskFailure {
  return {
    taskId: 'task-1',
    revision: 1,
    attempt: 1,
    nodeId: 'code',
    reason: 'node_failed',
    detail: 'node code failed on attempt 1',
    failingCheckIds: [],
    ...overrides,
  };
}

let reportNumber = 0;

/** An executor report of a succeeded run with one node attempt; overrides win. */
export function anExecutorReport(overrides: Partial<ExecutorReport> = {}): ExecutorReport {
  reportNumber += 1;
  return {
    runId: `executor-run-${reportNumber}`,
    status: 'succeeded',
    summary: 'the run finished',
    nodes: [{ nodeId: 'code', outcome: 'succeeded', summary: 'code finished', attempts: 1 }],
    usage: [],
    ...overrides,
  };
}
