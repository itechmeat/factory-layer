/**
 * Maps one `supervisor_wait_event` answer onto the factory's executor
 * events. APB 1.0.0-beta.1 wakes the supervisor with `node_failed`,
 * `node_timeout` or `anomaly`; reviews and host tasks arrive as wait reasons;
 * a terminal status ends the run. After a node failure APB parks the run for
 * its supervisor and never repeats the wake: later waits time out with
 * `pending_supervisor` still set. That parked state is `quiet` once the wake
 * was delivered, and the node failure itself when it was not (a re-attach
 * after a restart). A run that ends `aborted` after the factory stopped it
 * is `stopped`. A missing next cursor keeps the previous one.
 */

import { isTerminalStatus, type SupervisorWait, TERMINAL_RUN_STATUSES } from './apb-run-schemas';
import type { ExecutorEvent, WaitEventResult } from '../../ports/executor';

/** What the executor knows about the run beyond the answer. */
export interface WaitContext {
  /** The cursor the wait was asked with. */
  readonly afterSeq: number;
  /** A node-failure wake of the run's current park was already reported. */
  readonly wakeDelivered: boolean;
  /** The factory asked for the run to stop. */
  readonly stopRequested: boolean;
}

/** The mapped event, and whether it reported a node failure (which the caller remembers). */
export interface MappedWait extends WaitEventResult {
  readonly deliveredNodeFailure: boolean;
}

function nodeFailure(seq: number, node: string | null, detail: string | null): ExecutorEvent {
  return { kind: 'wake', seq, trigger: 'node_failed', nodeId: node, detail };
}

/** The event a wake trigger stands for. */
function wakeEvent(answer: SupervisorWait, afterSeq: number): ExecutorEvent {
  const wake = answer.wake;
  if (wake === null || wake === undefined) {
    return { kind: 'wake', seq: answer.next_after_seq ?? afterSeq, trigger: 'other', nodeId: null, detail: 'a wake without a trigger' };
  }
  const detail = wake.detail ?? null;
  switch (wake.trigger) {
    case 'node_failed': {
      return nodeFailure(wake.seq, wake.node, detail);
    }
    case 'node_timeout': {
      return nodeFailure(wake.seq, wake.node, detail === null ? 'timeout' : `timeout: ${detail}`);
    }
    case 'anomaly': {
      return { kind: 'wake', seq: wake.seq, trigger: 'stalled', nodeId: wake.node, detail };
    }
    default: {
      return {
        kind: 'wake',
        seq: wake.seq,
        trigger: 'other',
        nodeId: wake.node,
        detail: `${wake.trigger}${detail === null ? '' : `: ${detail}`}`,
      };
    }
  }
}

/** The event of a wait answer that is not a wake: terminal, host task, review, park or nothing. */
function otherEvent(answer: SupervisorWait, context: WaitContext): ExecutorEvent {
  const status = answer.run_status;
  if (isTerminalStatus(status)) {
    return { kind: 'terminal', status: status === 'aborted' && context.stopRequested ? 'stopped' : status };
  }
  if (answer.reason === 'host_task' || answer.pending_tasks !== undefined) return { kind: 'needs_host' };
  const seq = answer.next_after_seq ?? context.afterSeq;
  if (answer.reason === 'review' || answer.pending_review !== null) {
    return { kind: 'wake', seq, trigger: 'review', nodeId: null, detail: 'the run waits on a review gate' };
  }
  if (answer.reason === 'ended') {
    return { kind: 'wake', seq, trigger: 'stalled', nodeId: null, detail: `the run stopped moving in status ${answer.run_status}` };
  }
  const parked = answer.pending_supervisor;
  if (parked !== null && !context.wakeDelivered) {
    const timedOut = parked.trigger === 'node_timeout';
    return nodeFailure(
      seq,
      parked.node ?? null,
      timedOut ? 'timeout' : `the run waits for its supervisor after ${parked.trigger ?? 'a wake'}`,
    );
  }
  return { kind: 'quiet' };
}

/** Maps `answer`; see the module header. */
export function mapWait(answer: SupervisorWait, context: WaitContext): MappedWait {
  const nextAfterSeq = answer.next_after_seq ?? context.afterSeq;
  const plainWake = answer.reason === 'wake' && answer.pending_tasks === undefined && !TERMINAL_RUN_STATUSES.has(answer.run_status);
  const event = plainWake ? wakeEvent(answer, context.afterSeq) : otherEvent(answer, context);
  const deliveredNodeFailure = event.kind === 'wake' && event.trigger === 'node_failed';
  return { event, nextAfterSeq, deliveredNodeFailure };
}
