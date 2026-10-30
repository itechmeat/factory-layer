/**
 * The acceptance checks kept true to the spec: example checks come first
 * without any model, a derived check that contradicts an example or draws
 * the Critic's objection is dropped and traced, a failed review keeps its
 * checks, and at delivery a failed derived check the Critic objects to is
 * excused only while every example check passes.
 */

import { describe, expect, test } from 'bun:test';

import { BRAIN_DECISION_RETRIES, type RunOptionsInput } from '../domain';
import type { FactoryPorts } from './run-context';

import { RunFactory } from '.';
import { REVIEW_BATCH_SIZE } from './acceptance-review';
import { aSpec, aTask, cliCheck, commandCheck, drive, fakePorts, planOf, succeedRuns, type FakeClock } from './testing';

const SPEC = aSpec({
  markdown: ['# upcase', '', 'Prints its input in upper case.', '', '```', "$ printf 'a\\n' | upcase", 'A', '```', ''].join('\n'),
});

function run(ports: FactoryPorts & { readonly clock: FakeClock }, options: RunOptionsInput = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'review', spec: SPEC, options }));
}

function failed(checkId: string): { checkId: string; status: 'failed'; reasons: string[]; detail: string } {
  return { checkId, status: 'failed', reasons: ['stdout: expected exact "x", got "y"'], detail: '' };
}

describe('acceptance review at the start of a run', () => {
  test('example checks come first; a check contradicting an example and one the Critic objects to are dropped and traced', async () => {
    const ports = fakePorts();
    const contradicting = cliCheck({ id: 'lower', stdin: 'a\n', args: [], expectedStdout: { kind: 'exact', value: 'a\n' } });
    const objected = cliCheck({ id: 'invented' });
    const kept = cliCheck({ id: 'kept' });
    const inert = commandCheck({ id: 'inert', command: "printf 'a'" });
    planOf(ports, [aTask({ id: 'only' })], [contradicting, inert, objected, kept]);
    ports.brain.script.acceptance_review.answerWith({ decision: [{ checkId: 'invented', reason: 'the spec has no --help' }] });
    succeedRuns(ports);

    await run(ports);

    const checkIds = (await ports.store.load('review'))?.acceptanceChecks.map((check) => check.id);
    expect(checkIds).toEqual(['spec-example-1', 'kept']);
    const dropped = ports.sink.ofType('acceptance_check_dropped');
    expect(dropped.map((event) => [event.checkId, event.stage])).toEqual([
      ['lower', 'planning'],
      ['inert', 'planning'],
      ['invented', 'planning'],
    ]);
    expect(dropped[0]?.reason).toContain('contradicts spec-example-1');
    expect(dropped[1]?.reason).toContain('never runs the package');
    expect(dropped[2]?.reason).toContain('the spec has no --help');
    const [review] = ports.brain.callsOf('acceptance_review');
    expect(review?.args['checks']).toEqual([objected, kept]);
    expect(ports.sink.ofType('acceptance_produced')[0]?.checkIds).toEqual(['spec-example-1', 'kept']);
  });

  test('derived checks are reviewed in concurrent batches; a review that fails every attempt keeps its batch', async () => {
    const ports = fakePorts();
    const derived = Array.from({ length: REVIEW_BATCH_SIZE + 1 }, (_, index) => cliCheck({ id: `derived-${String(index)}` }));
    planOf(ports, [aTask({ id: 'only' })], derived);
    ports.brain.failNext('acceptance_review', 1 + BRAIN_DECISION_RETRIES, 'critic down');
    succeedRuns(ports);

    await run(ports);

    const reviews = ports.brain.callsOf('acceptance_review');
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    expect(reviews[1]?.startedAt).toBe(reviews[0]?.startedAt ?? 'missing');
    expect((await ports.store.load('review'))?.acceptanceChecks).toHaveLength(1 + derived.length);
    expect(ports.sink.ofType('acceptance_check_dropped')).toEqual([]);
  });

  test('an acceptance decision that fails every attempt keeps the example checks and marks acceptance unavailable', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.brain.failNext('acceptance', 1 + BRAIN_DECISION_RETRIES, 'brain down');
    succeedRuns(ports);

    const result = await run(ports);

    const state = await ports.store.load('review');
    expect(state?.acceptanceChecks.map((check) => check.id)).toEqual(['spec-example-1']);
    expect(state?.acceptanceUnavailable).toBe(true);
    expect(result.outcome).toBe('partial');
  });
});

describe('acceptance review at delivery', () => {
  test('a failed derived check the Critic objects to is excused while every example check passes', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'wrong-order' })]);
    ports.checks.setResult('wrong-order', failed('wrong-order'));
    ports.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' } });
    ports.brain.script.acceptance_review.answerWith({ decision: [] });
    ports.brain.script.acceptance_review.answerWith({ decision: [{ checkId: 'wrong-order', reason: 'the spec orders by count' }] });
    succeedRuns(ports);

    const result = await run(ports);

    expect(result.outcome).toBe('succeeded');
    const dropped = ports.sink.ofType('acceptance_check_dropped');
    expect(dropped.map((event) => [event.checkId, event.stage])).toEqual([['wrong-order', 'delivery']]);
    expect(ports.brain.callsOf('acceptance_review')[1]?.args['results']).not.toEqual([]);
  });

  test('a failed example check is never excused and keeps the derived failures counted', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'wrong-order' })]);
    ports.checks.setResult('wrong-order', failed('wrong-order'));
    ports.checks.setResult('spec-example-1', failed('spec-example-1'));
    ports.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' } });
    succeedRuns(ports);

    const result = await run(ports);

    expect(result.outcome).toBe('partial');
    expect(result.reason).toContain('spec-example-1');
    expect(result.reason).toContain('wrong-order');
    expect(ports.brain.callsOf('acceptance_review')).toHaveLength(1);
  });
});
