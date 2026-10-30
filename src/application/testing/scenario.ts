/**
 * Scripting shortcuts for orchestration tests on the fakes: a plan of the
 * given tasks with accepting critics, executor runs that succeed (at once or
 * later on the fake clock), and a sink that records the shared slot count at
 * every event, so tests state only what their scenario changes.
 */

import type { AcceptanceCheck, PlanTask, TraceEvent } from '../../domain';
import type { StartRunInput } from '../../ports';

import { aPlan } from './builders';
import type { FakePorts } from './fake-ports';
import { FakeSink } from './fake-sink';
import type { FakeSlots } from './fake-slots';

/** Scripts a valid plan of the tasks, the acceptance checks and a critic that accepts every task. */
export function planOf(ports: Pick<FakePorts, 'brain'>, tasks: readonly PlanTask[], checks: readonly AcceptanceCheck[] = []): void {
  ports.brain.script.plan.answerWith({ decision: aPlan(tasks) });
  ports.brain.script.acceptance.answerWith({ decision: checks });
  ports.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' } });
}

/**
 * Makes every started run whose start input the filter accepts (all by
 * default) report a succeeded terminal, `afterMs` after its start on the
 * fake clock (at once when 0).
 */
export function succeedRuns(
  ports: Pick<FakePorts, 'executor' | 'sleep'>,
  options: { afterMs?: number; when?: (input: StartRunInput) => boolean } = {},
): void {
  ports.executor.onStart((input, runId) => {
    if (options.when !== undefined && !options.when(input)) {
      return;
    }
    const finish = (): void => {
      ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
    };
    if (options.afterMs === undefined || options.afterMs === 0) {
      finish();
    } else {
      void ports.sleep(options.afterMs).then(finish);
    }
  });
}

/** A sink that also records how many shared slots were held when each event was emitted. */
export class SlotRecordingSink extends FakeSink {
  private readonly slots: FakeSlots;
  readonly liveCounts: { readonly type: TraceEvent['type']; readonly live: number }[] = [];

  constructor(slots: FakeSlots) {
    super();
    this.slots = slots;
  }

  override emit(event: TraceEvent): void {
    super.emit(event);
    this.liveCounts.push({ type: event.type, live: this.slots.liveCount() });
  }

  /** The most slots held at any event. */
  maxLive(): number {
    return Math.max(0, ...this.liveCounts.map((entry) => entry.live));
  }
}
