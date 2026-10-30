/**
 * Every port of a factory run as one set of wired fakes on one fake clock:
 * the shape the RunFactory takes, with each fake still reachable by its
 * concrete type so a test can script it and read what it recorded.
 */

import { GLOBAL_EXECUTOR_RUNS } from '../../domain';
import type { Sleep } from '../../ports';

import { FakeBrain } from './fake-brain';
import { FakeCheckRunner } from './fake-check-runner';
import { FakeClock, fakeSleep } from './fake-clock';
import { FakeCostTable } from './fake-cost-table';
import { FakeExecutor } from './fake-executor';
import { FakeMemory } from './fake-memory';
import { FakePlaybookAuthoring } from './fake-playbook-authoring';
import { FakeSink } from './fake-sink';
import { FakeSlots } from './fake-slots';
import { FakeStore } from './fake-store';
import { FakeWorkspace } from './fake-workspace';

/** The fakes of every port of a run, sharing one clock. */
export interface FakePorts {
  readonly brain: FakeBrain;
  readonly executor: FakeExecutor;
  readonly playbooks: FakePlaybookAuthoring;
  readonly memory: FakeMemory;
  readonly sink: FakeSink;
  readonly store: FakeStore;
  readonly workspace: FakeWorkspace;
  readonly checks: FakeCheckRunner;
  readonly costs: FakeCostTable;
  readonly slots: FakeSlots;
  readonly clock: FakeClock;
  readonly sleep: Sleep;
}

/** Fresh fakes on a fresh clock; `shared` reuses the clock and slots of another set (two runs in one process). */
export function fakePorts(shared?: Pick<FakePorts, 'clock' | 'sleep' | 'slots'>): FakePorts {
  const clock = shared?.clock ?? new FakeClock();
  const sleep = shared?.sleep ?? fakeSleep(clock);
  return {
    brain: new FakeBrain({ clock, sleep }),
    executor: new FakeExecutor({ clock, sleep }),
    playbooks: new FakePlaybookAuthoring(),
    memory: new FakeMemory(),
    sink: new FakeSink(),
    store: new FakeStore({ clock }),
    workspace: new FakeWorkspace(),
    checks: new FakeCheckRunner(),
    costs: new FakeCostTable(),
    slots: shared?.slots ?? new FakeSlots({ cap: GLOBAL_EXECUTOR_RUNS, sleep }),
    clock,
    sleep,
  };
}
