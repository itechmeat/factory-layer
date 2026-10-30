/**
 * Ports layer: the interfaces the application depends on and the adapters
 * implement (Brain, Executor, PlaybookAuthoring, Memory, TraceSink, Clock,
 * CostTable, Workspace). Ports may import the domain, nothing higher.
 *
 * Today it holds only `Clock`, the one port the skeleton exercises. The
 * factory-core change adds the RunStore, CheckRunner, ExecutionSlots and
 * Sleep ports beside it.
 */

/** The single source of wall-clock time, so time is injectable in tests. */
export interface Clock {
  now(): Date;
}

/** Injected wait so tests run on a fake clock. Must reject when the signal aborts. */
export interface Sleep {
  (ms: number, signal?: AbortSignal): Promise<void>;
}

export type { Brain, BrainDecision, PlaybookRequest } from './brain';
export type {
  CommandPostResult,
  Executor,
  ExecutorEvent,
  ExecutorNodeReport,
  ExecutorReport,
  ExecutorRunInfo,
  ExecutorStartInputs,
  StartRunInput,
  StartRunResult,
  StopResult,
  WaitEventResult,
} from './executor';
export type { PlaybookAuthoring, PlaybookTrial, PlaybookValidation, TrialStopResult } from './playbook-authoring';
export type { Memory, RecalledRun, RunOutcomeRecord } from './memory';
export type { TraceSink } from './trace-sink';
export type { RunStore } from './run-store';
export type { AdvanceResult, IntegrationPreparation, TaskTree, Workspace, WorkspaceErrorInfo } from './workspace';
export type { CheckRunner, CommandOutcome, PackageStepResult, PackageStepsResult } from './check-runner';
export type { CostTable } from './cost-table';
export type { ExecutionSlots, Slot } from './execution-slots';

export { BrainError } from './brain';
export { ExecutorError } from './executor';
export { MemoryError } from './memory';
export { StorageError } from './run-store';
export { WorkspaceError } from './workspace';
