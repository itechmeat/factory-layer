/**
 * The single writer of a run's state (design D3). Every change of the run
 * state goes through this object: `update` applies a change and saves, and
 * `transition` checks a task state change against the domain's allowed
 * transitions, saves the state through the RunStore, then emits the trace
 * event, in that order. Saves are serialized, so the store sees the states in
 * the order they were made. A save that fails is fatal for the run: the
 * owner remembers it, fires the storage-failure callback (which aborts the
 * run's signal) and every later save fails at once with StorageFailure.
 *
 * A confirmed stop intent stays until its continuation has a persisted
 * result (design D2a: replaced by its result): the next intent of the same
 * task, or the task failing, removes it in the same save.
 */

import { assertTransition, type PlanTask, type RunIntent, type RunState, type TaskRunState, type TaskState } from '../domain';
import type { RunStore } from '../ports';

import type { RunTrace } from './run-trace';

/** Thrown once the run state could not be saved: the run can no longer guarantee a resume. */
export class StorageFailure extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'StorageFailure';
  }
}

/** The correlation of a task on its trace events: id, current revision and, once dispatched, its attempt. */
export interface TaskCorrelation {
  readonly taskId: string;
  readonly revision: number;
  readonly attempt?: number;
}

export class RunOwner {
  private readonly current: RunState;
  private readonly store: RunStore;
  private readonly trace: RunTrace;
  private readonly onStorageFailure: (detail: string) => void;
  private saving: Promise<void> = Promise.resolve();
  private storageError: string | null = null;

  constructor(info: { state: RunState; store: RunStore; trace: RunTrace; onStorageFailure: (detail: string) => void }) {
    this.current = info.state;
    this.store = info.store;
    this.trace = info.trace;
    this.onStorageFailure = info.onStorageFailure;
  }

  /** The run state; read it, never change it outside `update` or `transition`. */
  get state(): Readonly<RunState> {
    return this.current;
  }

  /** The detail of the save failure that ended the run, or null while saves work. */
  get storageFailure(): string | null {
    return this.storageError;
  }

  /** A task's run-state entry; a task the plan does not hold is a programming error. */
  task(taskId: string): Readonly<TaskRunState> {
    const task = this.current.tasks[taskId];
    if (task === undefined) {
      throw new Error(`unknown task ${taskId}`);
    }
    return task;
  }

  /** A task of the plan; a task the plan does not hold is a programming error. */
  planTask(taskId: string): PlanTask {
    const task = this.current.plan.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw new Error(`unknown plan task ${taskId}`);
    }
    return task;
  }

  /** The correlation of the task's trace events right now. */
  correlation(taskId: string): TaskCorrelation {
    const task = this.task(taskId);
    return task.attemptsUsed > 0 ? { taskId, revision: task.revision, attempt: task.attemptsUsed } : { taskId, revision: task.revision };
  }

  /** Applies a change to the state and saves it. */
  async update(change: (state: RunState) => void): Promise<void> {
    this.ensureSavable();
    change(this.current);
    await this.save();
  }

  /** Appends an intent and saves (design D2a: before the side effect); it replaces the task's confirmed stop intents. */
  async addIntent(intent: RunIntent): Promise<void> {
    await this.update((state) => {
      if ('taskId' in intent && intent.taskId !== null) {
        dropConfirmedStops(state, intent.taskId);
      }
      state.intents.push(intent);
    });
  }

  /** Removes the intents the predicate selects and saves (after the side effect). */
  async removeIntents(selects: (intent: RunIntent) => boolean): Promise<void> {
    await this.update((state) => {
      state.intents = state.intents.filter((intent) => !selects(intent));
    });
  }

  /**
   * Moves a task to `to`: checks the transition, saves, then emits
   * task_state_changed. A move to `failed` records the reason as the
   * task's fail reason. `also` changes the state in the same save and
   * traces its own events before task_state_changed.
   */
  async transition(
    taskId: string,
    to: TaskState,
    reason: string,
    also?: { readonly change: (state: RunState) => void; readonly trace?: () => void },
  ): Promise<void> {
    const from = this.task(taskId).state;
    assertTransition(from, to);
    await this.update((state) => {
      also?.change(state);
      const task = state.tasks[taskId];
      if (task !== undefined) {
        state.tasks[taskId] = to === 'failed' ? { ...task, state: to, failReason: reason } : { ...task, state: to };
      }
      if (to === 'failed') {
        dropConfirmedStops(state, taskId);
      }
    });
    also?.trace?.();
    this.trace.emit({ type: 'task_state_changed', ...this.correlation(taskId), from, to, reason: this.trace.redact(reason) });
  }

  /** Marks a task failed with the reason, unless it already ended (integrated or failed); `change` goes in the same save. */
  async fail(taskId: string, reason: string, change?: (state: RunState) => void): Promise<void> {
    const state = this.task(taskId).state;
    if (state === 'failed' || state === 'integrated') {
      if (change !== undefined) {
        await this.update(change);
      }
      return;
    }
    await this.transition(taskId, 'failed', reason, change === undefined ? undefined : { change });
  }

  /** Saves the state; a failure ends every later save too. */
  async save(): Promise<void> {
    this.ensureSavable();
    const snapshot = structuredClone(this.current);
    const saved = this.saving.then(async () => {
      this.ensureSavable();
      try {
        await this.store.save(snapshot);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.storageError = this.trace.redact(detail);
        this.onStorageFailure(this.storageError);
        throw new StorageFailure(this.storageError);
      }
    });
    this.saving = saved.catch(() => undefined);
    await saved;
  }

  private ensureSavable(): void {
    if (this.storageError !== null) {
      throw new StorageFailure(this.storageError);
    }
  }
}

/** Removes the confirmed stop intents of the task: their continuation has its result. */
export function dropConfirmedStops(state: RunState, taskId: string): void {
  state.intents = state.intents.filter((intent) => !(intent.kind === 'stop' && intent.confirmed && intent.taskId === taskId));
}
