import { describe, expect, test } from 'bun:test';

import type { Runtime, RunOptionsInput } from '../domain';
import type { PackageStepResult, PackageStepsResult } from '../ports';

import { RunFactory } from '.';
import { aSpec, aTask, cliCheck, drive, FakeCheckRunner, fakePorts, planOf, succeedRuns, type FakePorts } from './testing';

const SPEC = aSpec();
const OUT = 'out/todo-cli';
/** The directory of the first clean copy the fake workspace hands out. */
const COPY = 'copy-1';

function run(ports: FakePorts, options: RunOptionsInput = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-v', spec: SPEC, options: { outDir: OUT, ...options } }));
}

/** Package steps of both runtimes where only the named step fails. */
function stepsFailing(failing: { readonly runtime: Runtime; readonly step: PackageStepResult['step'] }): PackageStepsResult {
  const steps = (['bun', 'npm'] as const).flatMap((runtime) =>
    (['install', 'build', 'test'] as const).map((step): PackageStepResult => ({
      runtime,
      step,
      ok: !(runtime === failing.runtime && step === failing.step),
      missingScript: false,
      outcome: null,
      detail: `${runtime} ${step}`,
    })),
  );
  return { dir: COPY, runtimes: ['bun', 'npm'], ok: false, steps };
}

/** A check runner whose package steps in the delivery copy never end. */
class EndlessDeliveryChecks extends FakeCheckRunner {
  override packageSteps(dir: string, runtimes: readonly Runtime[]): Promise<PackageStepsResult> {
    return dir === COPY ? new Promise<PackageStepsResult>(() => {}) : super.packageSteps(dir, runtimes);
  }
}

/** One task with one passing check, every run succeeding. */
function oneTask(ports: FakePorts): void {
  planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'help' })]);
  succeedRuns(ports);
}

describe('delivery gate', () => {
  for (const failing of [
    { runtime: 'bun', step: 'install' },
    { runtime: 'npm', step: 'build' },
    { runtime: 'npm', step: 'test' },
  ] as const) {
    test(`${failing.runtime} ${failing.step} failing copies nothing and fails the run`, async () => {
      const ports = fakePorts();
      oneTask(ports);
      ports.checks.setPackageSteps(COPY, stepsFailing(failing));

      const result = await run(ports);

      expect(result).toMatchObject({ outcome: 'failed', verified: false, deliveredDir: null });
      expect(result.reason).toContain(`${failing.runtime} ${failing.step}`);
      expect(ports.workspace.deliveries).toEqual([]);
      expect(ports.sink.ofType('delivery_done')[0]).toMatchObject({ copied: false, verified: false });
    });
  }

  test('deliverUnverified copies a failed verification and the outcome still records it', async () => {
    const ports = fakePorts();
    oneTask(ports);
    ports.checks.setPackageSteps(COPY, stepsFailing({ runtime: 'npm', step: 'test' }));

    const result = await run(ports, { deliverUnverified: true });

    expect(result).toMatchObject({ outcome: 'failed', verified: false, deliveredDir: OUT });
    expect(ports.workspace.deliveries).toEqual([{ copyDir: COPY, outDir: OUT, files: 3 }]);
  });

  test('deliverUnverified copies the integrated main before a verification that never ends', async () => {
    const base = fakePorts();
    const ports = { ...base, checks: new EndlessDeliveryChecks() };
    oneTask(ports);
    void run(ports, { deliverUnverified: true }).catch(() => undefined);

    await drive(ports.clock, ports.sleep(3_600_000));

    expect(ports.workspace.deliveries).toEqual([{ copyDir: COPY, outDir: OUT, files: 3 }]);
    expect(ports.sink.ofType('delivery_done')).toEqual([]);
  });

  test('deliverUnverified replaces the early copy with the verified tree when verification passes', async () => {
    const ports = fakePorts();
    oneTask(ports);

    const result = await run(ports, { deliverUnverified: true });

    expect(result).toMatchObject({ outcome: 'succeeded', verified: true, deliveredDir: OUT });
    expect(ports.workspace.deliveries).toEqual([
      { copyDir: COPY, outDir: OUT, files: 3 },
      { copyDir: COPY, outDir: OUT, files: 3 },
    ]);
  });

  test('a verified copy with every task integrated and every check passing succeeds', async () => {
    const ports = fakePorts();
    oneTask(ports);

    const result = await run(ports);

    expect(result).toEqual({ runId: 'run-v', outcome: 'succeeded', reason: null, deliveredDir: OUT, verified: true });
    expect(ports.checks.packageCalls.at(-1)).toEqual({ dir: COPY, runtimes: ['bun'] });
    expect((await ports.store.load('run-v'))?.intents).toEqual([]);
  });

  test('a verified copy with a failed acceptance check is partial', async () => {
    const ports = fakePorts();
    oneTask(ports);
    ports.checks.setResultsForDir(COPY, [{ checkId: 'help', status: 'failed', reasons: ['wrong output'], detail: '' }]);

    const result = await run(ports);

    expect(result.outcome).toBe('partial');
    expect(result.reason).toContain('help');
  });

  test('a verified copy with one of three tasks failed is partial', async () => {
    const ports = fakePorts();
    planOf(
      ports,
      ['a', 'b', 'c'].map((id) => aTask({ id, ownedPaths: [`src/${id}`] })),
      [cliCheck({ id: 'help' })],
    );
    ports.executor.startWith({ outcome: 'refused', policy: 'untrusted_playbook', detail: 'refused' });
    succeedRuns(ports);

    const result = await run(ports);

    expect(result.outcome).toBe('partial');
    expect(result.reason).toContain('a');
    expect(result.deliveredDir).toBe(OUT);
  });

  test('a verified copy is delivered as partial even when no task was integrated', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'help' })]);
    ports.executor.startWith({ outcome: 'refused', policy: 'untrusted_playbook', detail: 'not trusted' });

    const result = await run(ports);

    expect(result).toMatchObject({ outcome: 'partial', verified: true, deliveredDir: OUT });
    expect(result.reason).toContain('tasks not integrated: only');
  });

  test('an empty set of acceptance checks caps a verified, fully integrated run at partial', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], []);
    succeedRuns(ports);

    const result = await run(ports);

    expect(result).toMatchObject({ outcome: 'partial', reason: 'no acceptance checks' });
  });
});
