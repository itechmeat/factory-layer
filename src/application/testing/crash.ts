/**
 * Crash points for resume tests (design D2a): a run is driven until a saved
 * state matches the crash point, and from then on its process is frozen:
 * every port call of the crashed run waits forever and its trace events are
 * dropped, while the outside world (the executor's runs, the workspace's
 * `main`, the store's last saved state) stays as the crash left it. A crash
 * `after` a matching state writes it first; a crash `before` it does not.
 * The resumed run gets the same world with a fresh trace sink and fresh
 * shared slots, as a new process would.
 */

import type { RunState } from '../../domain';
import type { Sleep } from '../../ports';

import type { FactoryPorts } from '../run-context';
import type { FakePorts } from './fake-ports';
import { FakeSink } from './fake-sink';
import { FakeSlots } from './fake-slots';

/** Where the crash happens: on the first save whose state matches, after writing it or before. */
export interface CrashPoint {
  readonly when: 'before' | 'after';
  readonly matches: (state: RunState) => boolean;
}

/** A promise that never settles: a call of a crashed process. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Never settles: the crashed process makes no further progress.
  });
}

/** Wraps every method of the port so that, once crashed, each call waits forever. */
function freezable<T extends object>(port: T, crashed: () => boolean): T {
  return new Proxy(port, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]): unknown => (crashed() ? never() : Reflect.apply(value, target, args));
    },
  });
}

/** The ports of a run that crashes at the point, and a promise that resolves when it crashed. */
export function crashingPorts(ports: FakePorts, point: CrashPoint): { readonly ports: FactoryPorts; readonly crashed: Promise<void> } {
  let crashed = false;
  let onCrash: () => void = () => undefined;
  const crashedPromise = new Promise<void>((resolve) => {
    onCrash = resolve;
  });
  const isCrashed = (): boolean => crashed;
  const crash = (): void => {
    crashed = true;
    onCrash();
  };
  const sleep: Sleep = (ms, signal) => (crashed ? never() : ports.sleep(ms, signal));
  const store = freezable(ports.store, isCrashed);
  const saving = {
    save: async (state: RunState): Promise<void> => {
      if (crashed) {
        return never();
      }
      if (point.matches(state)) {
        if (point.when === 'after') {
          await ports.store.save(state);
        }
        crash();
        return never();
      }
      return ports.store.save(state);
    },
    load: (runId: string) => store.load(runId),
    appendIntervention: (runId: string, note: string) => store.appendIntervention(runId, note),
  };
  return {
    crashed: crashedPromise,
    ports: {
      brain: freezable(ports.brain, isCrashed),
      executor: freezable(ports.executor, isCrashed),
      playbooks: freezable(ports.playbooks, isCrashed),
      memory: freezable(ports.memory, isCrashed),
      sink: { emit: (event) => (crashed ? undefined : ports.sink.emit(event)) },
      store: saving,
      workspace: freezable(ports.workspace, isCrashed),
      checks: freezable(ports.checks, isCrashed),
      costs: ports.costs,
      slots: freezable(ports.slots, isCrashed),
      clock: ports.clock,
      sleep,
    },
  };
}

/** The ports of the process that resumes: the same world, a fresh sink and fresh shared slots. */
export function restartedPorts(ports: FakePorts): FakePorts {
  return { ...ports, sink: new FakeSink(), slots: new FakeSlots({ cap: 4, sleep: ports.sleep }) };
}
