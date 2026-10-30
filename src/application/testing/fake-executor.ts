/**
 * A scriptable `Executor` for tests: a registry of runs with scripted event
 * sequences served by cursor, scriptable starts (success, indeterminate,
 * refused, with delays), late-appearing runs for the lookup, per-run stop
 * outcomes and reports, and every recovery command recorded with its posted
 * sequence. Time passes only on the injected fake clock.
 */

import {
  ExecutorError,
  type Clock,
  type CommandPostResult,
  type Executor,
  type ExecutorEvent,
  type ExecutorNodeReport,
  type ExecutorReport,
  type ExecutorRunInfo,
  type Sleep,
  type StartRunInput,
  type StartRunResult,
  type StopResult,
  type WaitEventResult,
} from '../../ports';

/** How a startRun call answers; the queue is consumed in order, then the default. */
export type FakeStartScript =
  | { readonly outcome: 'ok'; readonly runId?: string; readonly supervisorToken?: string; readonly delayMs?: number }
  | { readonly outcome: 'indeterminate'; readonly detail: string; readonly runId?: string; readonly delayMs?: number }
  | { readonly outcome: 'refused'; readonly policy: string; readonly detail: string; readonly delayMs?: number };

/** How the next stop of a run answers; `detail` overrides the default detail text. */
export interface FakeStopScript {
  readonly confirmed: boolean;
  readonly detail?: string;
  readonly delayMs?: number;
}

/** The detail of a confirmed stop when the script names none. */
export const FAKE_STOP_CONFIRMED_DETAIL = 'run stopped';

/** The detail of an unconfirmed stop when the script names none. */
export const FAKE_STOP_UNCONFIRMED_DETAIL = 'stop not confirmed before the deadline';

/** A run registered for the lookup, visible after its delay. */
export interface FakeFoundRun {
  readonly runId: string;
  readonly playbook: string;
  readonly tree: string;
  readonly status?: ExecutorRunInfo['status'];
}

/** One recovery command the fake recorded, with the sequence it was posted at. */
export interface FakeExecutorCommand {
  readonly kind: 'append_context' | 'retry_node' | 'rebind_profile';
  readonly runId: string;
  readonly nodeId: string | null;
  readonly profile: string | null;
  readonly text: string | null;
  readonly postedSeq: number;
}

/** A run as the fake holds it; `dispatchKey` and `supervisorToken` are null for runs no start created. */
export interface FakeRun {
  readonly runId: string;
  readonly playbook: string;
  readonly tree: string;
  readonly dispatchKey: string | null;
  readonly createdAtMs: number;
  readonly visibleAtMs: number;
  status: ExecutorRunInfo['status'];
  readonly supervisorToken: string | null;
}

interface FakeRunInternal extends FakeRun {
  readonly events: ExecutorEvent[];
  servedIndex: number;
  nextPostedSeq: number;
}

const TERMINAL_RUN_STATUSES: readonly ExecutorRunInfo['status'][] = ['succeeded', 'failed', 'aborted', 'stopped'];

/** A live run has no honest report status yet; the application reports only finished runs. */
const REPORT_STATUS: Record<ExecutorRunInfo['status'], ExecutorReport['status']> = {
  created: 'aborted',
  running: 'aborted',
  succeeded: 'succeeded',
  failed: 'failed',
  aborted: 'aborted',
  stopped: 'stopped',
  unknown: 'aborted',
};

export class FakeExecutor implements Executor {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly runById = new Map<string, FakeRunInternal>();
  private readonly startQueue: FakeStartScript[] = [];
  private startFallback: FakeStartScript = { outcome: 'ok' };
  private readonly stopScripts = new Map<string, FakeStopScript>();
  private readonly reports = new Map<string, ExecutorReport>();
  private readonly startLog: StartRunInput[] = [];
  private readonly commandLog: FakeExecutorCommand[] = [];
  private readonly startHandlers: ((input: StartRunInput, runId: string) => void)[] = [];
  private nextRunNumber = 1;

  constructor(deps: { clock: Clock; sleep: Sleep }) {
    this.clock = deps.clock;
    this.sleep = deps.sleep;
  }

  /** Every run the fake knows, keyed by run id. */
  get runs(): ReadonlyMap<string, FakeRun> {
    return this.runById;
  }

  /** Every startRun input, in call order. */
  get starts(): readonly StartRunInput[] {
    return this.startLog;
  }

  /** Every recovery command, in post order. */
  get commands(): readonly FakeExecutorCommand[] {
    return this.commandLog;
  }

  /** Queues how the next startRun calls answer; consumed in order. */
  startWith(script: FakeStartScript): void {
    this.startQueue.push(script);
  }

  /** Sets how a startRun answers once the queue is empty. */
  startDefault(script: FakeStartScript): void {
    this.startFallback = script;
  }

  /**
   * Calls the handler for every run a start creates, right after it is
   * registered, so a test can script its events, stop and report by the
   * start input (playbook, tree, dispatch key) without knowing the run id.
   */
  onStart(handler: (input: StartRunInput, runId: string) => void): void {
    this.startHandlers.push(handler);
  }

  /** Registers a run the lookup reports only after `delayMs` of fake time. */
  appearLater(run: FakeFoundRun, delayMs: number): void {
    const nowMs = this.clock.now().getTime();
    this.runById.set(run.runId, {
      runId: run.runId,
      playbook: run.playbook,
      tree: run.tree,
      dispatchKey: null,
      createdAtMs: nowMs,
      visibleAtMs: nowMs + delayMs,
      status: run.status ?? 'running',
      supervisorToken: null,
      events: [],
      servedIndex: 0,
      nextPostedSeq: 1,
    });
  }

  /** Appends one event to the run's scripted sequence. */
  pushEvent(runId: string, event: ExecutorEvent): void {
    this.mustRun(runId).events.push(event);
  }

  /** Scripts the next stop of the run: confirmed or not, after the delay. */
  setStopOutcome(runId: string, script: FakeStopScript): void {
    this.mustRun(runId);
    this.stopScripts.set(runId, script);
  }

  /** Scripts what report(runId) returns. */
  setReport(runId: string, report: ExecutorReport): void {
    this.reports.set(runId, report);
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    this.startLog.push(input);
    const script = this.startQueue.shift() ?? this.startFallback;
    await this.pause(script.delayMs);
    if (script.outcome === 'refused') {
      return { ok: false, outcome: 'refused', policy: script.policy, detail: script.detail };
    }
    const number = this.nextRunNumber;
    this.nextRunNumber += 1;
    if (script.outcome === 'indeterminate') {
      if (script.runId !== undefined) {
        this.registerRun(script.runId, input, 'running', null);
      }
      return { ok: false, outcome: 'indeterminate', detail: script.detail };
    }
    const runId = script.runId ?? `executor-run-${number}`;
    const supervisorToken = script.supervisorToken ?? `token-${number}`;
    this.registerRun(runId, input, 'running', supervisorToken);
    for (const handler of this.startHandlers) {
      handler(input, runId);
    }
    return { ok: true, runId, supervisorToken };
  }

  async findRuns(query: {
    readonly playbook: string;
    readonly tree: string;
    readonly notBefore: string;
  }): Promise<readonly ExecutorRunInfo[]> {
    const notBeforeMs = Date.parse(query.notBefore);
    const nowMs = this.clock.now().getTime();
    return [...this.runById.values()]
      .filter(
        (run) => run.playbook === query.playbook && run.tree === query.tree && run.createdAtMs >= notBeforeMs && run.visibleAtMs <= nowMs,
      )
      .map((run) => ({ runId: run.runId, status: run.status }));
  }

  async waitEvent(runId: string, afterSeq: number, sliceMs: number): Promise<WaitEventResult> {
    const run = this.mustRun(runId);
    while (run.servedIndex < run.events.length) {
      const event = run.events[run.servedIndex];
      if (event === undefined) {
        break;
      }
      run.servedIndex += 1;
      if (event.kind === 'wake') {
        if (event.seq <= afterSeq) {
          continue;
        }
        return { event, nextAfterSeq: event.seq };
      }
      if (event.kind === 'terminal') {
        run.status = event.status;
      }
      return { event, nextAfterSeq: afterSeq };
    }
    await this.sleep(sliceMs);
    return { event: { kind: 'quiet' }, nextAfterSeq: afterSeq };
  }

  async report(runId: string): Promise<ExecutorReport> {
    const run = this.mustRun(runId);
    const scripted = this.reports.get(runId);
    if (scripted !== undefined) {
      return scripted;
    }
    const nodes: ExecutorNodeReport[] = [];
    return { runId, status: REPORT_STATUS[run.status], summary: `run ${runId} is ${run.status}`, nodes, usage: [] };
  }

  async appendContext(runId: string, text: string): Promise<CommandPostResult> {
    this.mustRun(runId);
    return this.post({ kind: 'append_context', runId, nodeId: null, profile: null, text });
  }

  async retryNode(runId: string, nodeId: string): Promise<CommandPostResult> {
    this.mustRun(runId);
    return this.post({ kind: 'retry_node', runId, nodeId, profile: null, text: null });
  }

  async rebindProfile(runId: string, nodeId: string, profile: string): Promise<CommandPostResult> {
    this.mustRun(runId);
    return this.post({ kind: 'rebind_profile', runId, nodeId, profile, text: null });
  }

  async stop(runId: string, _deadlineMs: number): Promise<StopResult> {
    const run = this.mustRun(runId);
    const script = this.stopScripts.get(runId);
    await this.pause(script?.delayMs);
    if (script !== undefined && !script.confirmed) {
      return { outcome: 'unconfirmed', detail: script.detail ?? FAKE_STOP_UNCONFIRMED_DETAIL };
    }
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      run.status = 'stopped';
    }
    return { outcome: 'stopped', detail: script?.detail ?? FAKE_STOP_CONFIRMED_DETAIL };
  }

  async attach(runId: string, supervisorToken: string): Promise<{ readonly attached: boolean; readonly detail: string }> {
    const run = this.runById.get(runId);
    if (run === undefined) {
      return { attached: false, detail: `unknown run ${runId}` };
    }
    if (run.supervisorToken !== supervisorToken) {
      return { attached: false, detail: `token mismatch for run ${runId}` };
    }
    return { attached: true, detail: `attached to ${runId}` };
  }

  private registerRun(runId: string, input: StartRunInput, status: ExecutorRunInfo['status'], supervisorToken: string | null): void {
    this.runById.set(runId, {
      runId,
      playbook: input.playbook,
      tree: input.tree,
      dispatchKey: input.dispatchKey,
      createdAtMs: this.clock.now().getTime(),
      visibleAtMs: 0,
      status,
      supervisorToken,
      events: [],
      servedIndex: 0,
      nextPostedSeq: 1,
    });
  }

  private post(command: Omit<FakeExecutorCommand, 'postedSeq'>): CommandPostResult {
    const run = this.mustRun(command.runId);
    const postedSeq = run.nextPostedSeq;
    run.nextPostedSeq += 1;
    this.commandLog.push({ ...command, postedSeq });
    return { accepted: true, postedSeq };
  }

  private mustRun(runId: string): FakeRunInternal {
    const run = this.runById.get(runId);
    if (run === undefined) {
      throw new ExecutorError({ reason: 'protocol', detail: `unknown executor run ${runId}` });
    }
    return run;
  }

  private pause(delayMs: number | undefined): Promise<void> {
    return delayMs === undefined || delayMs <= 0 ? Promise.resolve() : this.sleep(delayMs);
  }
}
