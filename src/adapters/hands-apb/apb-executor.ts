/**
 * `ApbExecutor`: the factory's hands over `apb mcp` (APB 1.0.0-beta.1),
 * implementing the `Executor` port. It starts supervised runs in task trees, waits on
 * their supervisor events, posts recovery commands, stops runs and confirms
 * the stop, re-attaches runs after a restart, finds runs whose start answer
 * was lost, and reports finished runs with usage per attempt.
 *
 * State: a map of the live runs, run id to the run's supervisor token
 * (registered as a secret on every connection, never traced), its task tree
 * (looked up with `run_status` for a run attached after a restart), whether
 * its node-failure wake was delivered and, once a replacement connection
 * rejected its token, why it is lost. A run leaves the map once its terminal
 * event was delivered or its stop confirmed; the ids the factory asked to
 * stop are kept apart, so a later report still says `stopped`. Every call is
 * bounded by an MCP timeout; one dead connection is replaced and each live
 * run re-attached on its own (see `apb-session.ts`): a run whose token APB
 * rejects is lost alone, its later calls fail with `ApbConnectionLostError`.
 * A start in a tree that holds a live run is refused before the task file is
 * written; APB's busy refusal stays the backstop. Refusals and lost starts
 * are results; every other failure is the port's `ExecutorError` (a lost
 * connection is its `ApbConnectionLostError` subclass, reason `failed`).
 */

import { existsSync } from 'node:fs';
import { z } from 'zod';

import {
  type CommandPostResult,
  type Executor,
  ExecutorError,
  type ExecutorReport,
  type ExecutorRunInfo,
  type StartRunInput,
  type StartRunResult,
  type StopResult,
  type WaitEventResult,
} from '../../ports/executor';
import { isDeadConnection, McpToolError, messageOf } from '../mcp-stdio/errors';
import { RunReportSchema, RunEventsSchema } from './apb-report-schemas';
import { CommandPostSchema, isTerminalStatus, RunStartSchema, RunStatusAnswerSchema, SupervisorWaitSchema } from './apb-run-schemas';
import { ApbConnectionLostError, type ApbConnection, ApbSession, executorErrorOf } from './apb-session';
import type { ApbToolCaller } from './apb-tool-caller';
import { mapWait } from './event-mapping';
import { matchingRuns } from './recover-start';
import { buildReport } from './run-report';
import { STARTER_PARAMS, startParams, writeTaskFile } from './start-inputs';
import { stopAndConfirm } from './stop-run';

/** Timeouts of the executor, in milliseconds; every field has a default. */
export interface ApbExecutorTimeouts {
  /** One `playbook_run`; past it the start is indeterminate. */
  readonly startMs?: number;
  /** One read or command call. */
  readonly callMs?: number;
  /** Room between a wait slice and its MCP request timeout. */
  readonly waitMarginMs?: number;
  /** A run lookup, all its calls together. */
  readonly lookupMs?: number;
  /** Pause between two `run_status` polls of a stop. */
  readonly pollIntervalMs?: number;
}

const DEFAULTS: Required<ApbExecutorTimeouts> = {
  startMs: 60_000,
  callMs: 30_000,
  waitMarginMs: 5000,
  lookupMs: 30_000,
  pollIntervalMs: 1000,
};

/** The longest wait slice APB accepts, in milliseconds. */
const APB_MAX_WAIT_MS = 1_800_000;

const PlaybookParamsSchema = z.looseObject({ params: z.array(z.looseObject({ name: z.string() })) });

interface RunState {
  readonly token: string;
  /** The task tree; `undefined` until looked up for a run attached after a restart. */
  tree: string | undefined;
  wakeDelivered: boolean;
  /** Why the run is lost: a replacement connection rejected its token. */
  lost: string | undefined;
}

/** The executor over one `apb mcp` session. */
export class ApbExecutor implements Executor {
  private readonly session: ApbSession;
  private readonly timeouts: Required<ApbExecutorTimeouts>;
  private readonly runs = new Map<string, RunState>();
  /** The runs the factory asked to stop, kept after they leave `runs`. */
  private readonly stopRequested = new Set<string>();

  /** `connect` opens an `apb mcp` connection (rooted at the factory repository, `APB_EXECUTION=cli`). */
  constructor(connect: () => Promise<ApbConnection>, timeouts: ApbExecutorTimeouts = {}) {
    this.timeouts = { ...DEFAULTS, ...timeouts };
    this.session = new ApbSession(connect, (caller) => this.reattachAll(caller));
  }

  /** Starts a supervised run of `input.playbook` in `input.tree`. */
  async startRun(input: StartRunInput): Promise<StartRunResult> {
    if (!existsSync(input.tree)) {
      return { ok: false, outcome: 'refused', policy: 'task_tree_missing', detail: `the task tree ${input.tree} does not exist` };
    }
    let declared = STARTER_PARAMS[input.playbook];
    if (declared === undefined) {
      try {
        declared = await this.declaredParams(input.playbook);
      } catch (error) {
        if (error instanceof ExecutorError && error.reason === 'failed' && !(error instanceof ApbConnectionLostError)) {
          return { ok: false, outcome: 'refused', policy: 'unknown_playbook', detail: error.message };
        }
        throw error;
      }
    }
    const mapped = startParams(declared, input.inputs);
    if (!mapped.ok) {
      return { ok: false, outcome: 'refused', policy: 'missing_input', detail: `missing input for params: ${mapped.missing.join(', ')}` };
    }
    const holder = await this.liveRunIn(input.tree);
    if (holder !== undefined) {
      return { ok: false, outcome: 'refused', policy: 'tree_busy', detail: `the task tree ${input.tree} holds the live run ${holder}` };
    }
    writeTaskFile(input.tree, input.inputs.taskText);
    const args = { id: input.playbook, supervise: 'self', worktree: input.tree, params: mapped.params };
    try {
      const start = await this.session.run(
        (caller) => caller.callToolParsed('playbook_run', args, RunStartSchema, { timeoutMs: this.timeouts.startMs }),
        false,
      );
      if (start.kind === 'refused')
        return { ok: false, outcome: 'refused', policy: start.policy, detail: `refused by APB policy ${start.policy}: ${start.detail}` };
      (await this.session.caller()).addSecret(start.token);
      this.runs.set(start.runId, { token: start.token, tree: input.tree, wakeDelivered: false, lost: undefined });
      return { ok: true, runId: start.runId, supervisorToken: start.token };
    } catch (error) {
      // A tool error is APB declining the start (a busy tree, a missing one); anything else may have created the run.
      if (error instanceof McpToolError) return { ok: false, outcome: 'refused', policy: 'apb_declined', detail: messageOf(error) };
      if (error instanceof ApbConnectionLostError) throw error;
      return { ok: false, outcome: 'indeterminate', detail: messageOf(error) };
    }
  }

  /** Runs of `query.playbook` in `query.tree` started at or after `query.notBefore`. */
  async findRuns(query: {
    readonly playbook: string;
    readonly tree: string;
    readonly notBefore: string;
  }): Promise<readonly ExecutorRunInfo[]> {
    const identity = { playbookId: query.playbook, worktree: query.tree, calledAtMs: Date.parse(query.notBefore) };
    const matches = await this.call(
      'runs_list',
      (caller) => matchingRuns(caller, identity, performance.now() + this.timeouts.lookupMs),
      true,
    );
    return matches.map(({ runId, status }) => ({ runId, status: this.infoStatus(runId, status) }));
  }

  /** Waits up to `sliceMs` for the run's next event after `afterSeq`. */
  async waitEvent(runId: string, afterSeq: number, sliceMs: number): Promise<WaitEventResult> {
    const run = this.known(runId);
    const slice = Math.min(Math.max(0, Math.floor(sliceMs)), APB_MAX_WAIT_MS);
    const answer = await this.call(
      'supervisor_wait_event',
      (caller) =>
        caller.callToolParsed('supervisor_wait_event', { token: run.token, after_seq: afterSeq, timeout_ms: slice }, SupervisorWaitSchema, {
          timeoutMs: slice + this.timeouts.waitMarginMs,
        }),
      true,
    );
    const mapped = mapWait(answer, { afterSeq, wakeDelivered: run.wakeDelivered, stopRequested: this.stopRequested.has(runId) });
    if (mapped.deliveredNodeFailure) run.wakeDelivered = true;
    if (mapped.event.kind === 'terminal') this.runs.delete(runId);
    return { event: mapped.event, nextAfterSeq: mapped.nextAfterSeq };
  }

  /** The report of a finished run. */
  async report(runId: string): Promise<ExecutorReport> {
    const timeoutMs = this.timeouts.callMs;
    const report = await this.call(
      'run_report',
      (caller) => caller.callToolParsed('run_report', { run_id: runId }, RunReportSchema, { timeoutMs }),
      true,
    );
    const runStatus = report.run_status;
    if (!isTerminalStatus(runStatus)) {
      throw new ExecutorError({ reason: 'failed', detail: `run_report: run ${runId} is not finished (status ${runStatus})` });
    }
    const journal = await this.call(
      'run_events',
      (caller) => caller.callToolParsed('run_events', { run_id: runId }, RunEventsSchema, { timeoutMs }),
      true,
    );
    const status = runStatus === 'aborted' && this.stopRequested.has(runId) ? 'stopped' : runStatus;
    return this.guard('run_events', () => buildReport(report, journal.events, status));
  }

  /** Appends a note to the run's context. */
  appendContext(runId: string, text: string): Promise<CommandPostResult> {
    return this.post('supervisor_context_append', runId, { note: text });
  }

  /** Retries a failed node. */
  retryNode(runId: string, nodeId: string): Promise<CommandPostResult> {
    return this.post('supervisor_node_retry', runId, { node: nodeId });
  }

  /** Rebinds a node to another profile. */
  rebindProfile(runId: string, nodeId: string, profile: string): Promise<CommandPostResult> {
    return this.post('supervisor_rebind_profile', runId, { node: nodeId, profile });
  }

  /** Stops the run and confirms it terminal with no live driver within `deadlineMs`. */
  async stop(runId: string, deadlineMs: number): Promise<StopResult> {
    this.stopRequested.add(runId);
    const deadline = performance.now() + deadlineMs;
    for (;;) {
      const used = this.session.generation;
      const confirmation = await stopAndConfirm(await this.session.caller(), runId, deadline, this.timeouts.pollIntervalMs);
      if (confirmation.confirmed) {
        this.runs.delete(runId);
        return { outcome: 'stopped', detail: `the run is ${confirmation.status} and no driver holds it` };
      }
      if (confirmation.connectionLost === undefined) {
        return { outcome: 'unconfirmed', detail: `not confirmed within ${deadlineMs} ms; last status ${confirmation.status ?? 'unknown'}` };
      }
      try {
        await this.session.replaceAfter(used, confirmation.connectionLost);
      } catch (error) {
        return { outcome: 'unconfirmed', detail: `connection lost: ${messageOf(error)}` };
      }
      if (performance.now() >= deadline) return { outcome: 'unconfirmed', detail: `connection lost: ${confirmation.connectionLost}` };
    }
  }

  /** Restores supervision of a run from its token, after a restart. */
  async attach(runId: string, supervisorToken: string): Promise<{ readonly attached: boolean; readonly detail: string }> {
    try {
      await this.call('supervisor_wait_event', (caller) => this.probeToken(caller, supervisorToken), true);
    } catch (error) {
      if (error instanceof ExecutorError && error.reason === 'failed' && !(error instanceof ApbConnectionLostError)) {
        return { attached: false, detail: error.message };
      }
      throw error;
    }
    // A parked run whose wake this process never reported is reported again by the next wait.
    this.runs.set(runId, { token: supervisorToken, tree: undefined, wakeDelivered: false, lost: undefined });
    return { attached: true, detail: 'the supervisor token is valid' };
  }

  /** The live connection, for `ApbAuthoring` to share. */
  connection(): Promise<ApbToolCaller> {
    return this.session.caller();
  }

  /** Closes the `apb mcp` connection; detached runs keep running in APB. */
  close(): Promise<void> {
    return this.session.close();
  }

  /** Registers `token` and checks it with a zero-length wait. */
  private async probeToken(caller: ApbToolCaller, token: string): Promise<void> {
    caller.addSecret(token);
    await caller.callToolParsed('supervisor_wait_event', { token, timeout_ms: 0 }, SupervisorWaitSchema, {
      timeoutMs: this.timeouts.callMs,
    });
  }

  /**
   * Re-attaches each live run on a replacement connection on its own: a run
   * whose token APB rejects is marked lost; only a replacement that is dead
   * too fails the whole re-attach.
   */
  private async reattachAll(caller: ApbToolCaller): Promise<void> {
    for (const [runId, run] of this.runs) {
      if (run.lost !== undefined) continue;
      try {
        await this.probeToken(caller, run.token);
      } catch (error) {
        if (isDeadConnection(error)) throw error;
        run.lost = `run ${runId} could not be re-attached on the replacement connection: ${messageOf(error)}`;
      }
    }
  }

  /**
   * The live run whose task tree is `tree`, looking up the trees of runs
   * attached after a restart. A lookup that fails for one run (other than a
   * dead connection) leaves that run's tree unknown, so it never blocks a
   * start; APB's busy refusal remains the backstop.
   */
  private async liveRunIn(tree: string): Promise<string | undefined> {
    for (const [runId, run] of this.runs) {
      if (run.lost !== undefined) continue;
      if (run.tree === undefined) {
        try {
          run.tree = await this.treeOf(runId);
        } catch (error) {
          if (error instanceof ApbConnectionLostError) throw error;
          run.tree = '';
        }
      }
      if (run.tree === tree) return runId;
    }
    return undefined;
  }

  /** The task tree `run_status` reports for `runId`; an empty string when it reports none. */
  private async treeOf(runId: string): Promise<string> {
    const status = await this.call(
      'run_status',
      (caller) => caller.callToolParsed('run_status', { run_id: runId }, RunStatusAnswerSchema, { timeoutMs: this.timeouts.callMs }),
      true,
    );
    return status.worktree ?? '';
  }

  private known(runId: string): RunState {
    const run = this.runs.get(runId);
    if (run === undefined)
      throw new ExecutorError({ reason: 'failed', detail: `run ${runId} is not known to this executor; attach it first` });
    if (run.lost !== undefined) throw new ApbConnectionLostError(run.lost);
    return run;
  }

  private infoStatus(runId: string, status: string): ExecutorRunInfo['status'] {
    if (status === 'aborted' && this.stopRequested.has(runId)) return 'stopped';
    if (status === 'paused') return 'running';
    return status === 'created' || status === 'running' || status === 'succeeded' || status === 'failed' || status === 'aborted'
      ? status
      : 'unknown';
  }

  /** The params `playbook` declares, read from APB. */
  private async declaredParams(playbook: string): Promise<readonly string[]> {
    const answer = await this.call(
      'playbook_get',
      (caller) => caller.callToolParsed('playbook_get', { id: playbook }, PlaybookParamsSchema, { timeoutMs: this.timeouts.callMs }),
      true,
    );
    return answer.params.map((param) => param.name);
  }

  private async post(tool: string, runId: string, args: Record<string, string>): Promise<CommandPostResult> {
    const run = this.known(runId);
    try {
      const posted = await this.session.run(
        (caller) => caller.callToolParsed(tool, { token: run.token, ...args }, CommandPostSchema, { timeoutMs: this.timeouts.callMs }),
        false,
      );
      return { accepted: true, postedSeq: posted.posted_seq };
    } catch (error) {
      if (error instanceof McpToolError) return { accepted: false, postedSeq: null };
      throw executorErrorOf(tool, error);
    }
  }

  /** Runs `work` on the session, mapping every failure to a typed executor error. */
  private async call<T>(tool: string, work: (caller: ApbToolCaller) => Promise<T>, repeatable: boolean): Promise<T> {
    try {
      return await this.session.run(work, repeatable);
    } catch (error) {
      throw executorErrorOf(tool, error);
    }
  }

  private guard<T>(tool: string, work: () => T): T {
    try {
      return work();
    } catch (error) {
      throw executorErrorOf(tool, error);
    }
  }
}
