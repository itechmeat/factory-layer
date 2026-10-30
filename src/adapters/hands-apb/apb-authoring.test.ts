import { describe, expect, test } from 'bun:test';

import { McpToolError } from '../mcp-stdio/errors';
import { ApbAuthoring } from './apb-authoring';
import { RunStatusAnswerSchema, RunStopSchema } from './apb-run-schemas';
import { answerOf, listOf, recorded } from './testing/apb-fixtures';
import { FakeApb, type FakeHandler, never, sequence } from './testing/fake-apb';

/** The recorded trial run: draft id, run id and start. */
const DRAFT = 'authoring-capture-trial';
const RUN = 'authoring-capture-trial-1793389476955';
const STARTED = 1793389476975;

function authoring(handlers: Record<string, FakeHandler>): { apb: FakeApb; store: ApbAuthoring } {
  const apb = new FakeApb(handlers);
  return { apb, store: new ApbAuthoring(async () => apb, { callMs: 200, pollIntervalMs: 5 }) };
}

/** The recorded `runs_list` with the trial still running, plus runs that are not this trial's. */
function liveRuns(): Record<string, unknown>[] {
  const [trial] = listOf('runs_list-trial');
  return [
    { ...trial, status: 'running' },
    { ...trial, run_id: 'other-1', playbook: 'implement-task', status: 'running' },
    { ...trial, run_id: `${DRAFT}-1`, started_ts: STARTED - 60_000, status: 'running' },
  ];
}

describe('the recorded trial answers parse', () => {
  test('run_status and run_stop of the trial run', () => {
    expect(RunStatusAnswerSchema.safeParse(recorded('run_status-trial-succeeded').answer).success).toBe(true);
    expect(RunStopSchema.safeParse(recorded('run_stop-terminal').answer).success).toBe(true);
  });

  test('a succeeded trial is ok and its instruction is passed through', async () => {
    const { apb, store } = authoring({ playbook_trial: async () => answerOf('playbook_trial-succeeded') });
    expect((await store.trial(DRAFT, {}, 'write it')).ok).toBe(true);
    expect(apb.callsTo('playbook_trial')[0]?.args).toEqual({ id: DRAFT, params: {}, instruction: 'write it' });
  });

  test('an agent trial ran in a throwaway worktree: the whole answer reaches the review', async () => {
    const { store } = authoring({ playbook_trial: async () => answerOf('playbook_trial-agent-worktree') });
    const trial = await store.trial('authored-readme-mvve7wt0-d1', {}, 'write it');
    expect(trial.ok).toBe(true);
    expect(trial.output).toContain('?? docs/trial/');
    expect(trial.output).toContain('throwaway git worktree');
  });
});

describe('stopTrials finds the trial runs of a draft by playbook and start time', () => {
  test('a trial run the list already shows ended needs no stop', async () => {
    const { apb, store } = authoring({ runs_list: async () => listOf('runs_list-trial') });
    const result = await store.stopTrials(DRAFT, STARTED - 50, 1_000);
    expect(result.runs).toEqual([{ runId: RUN, outcome: 'already_ended' }]);
    expect(apb.callsTo('run_stop')).toHaveLength(0);
  });

  test('a live trial run is stopped and confirmed; other playbooks and earlier runs are left alone', async () => {
    const { apb, store } = authoring({
      runs_list: async () => liveRuns(),
      run_stop: async () => answerOf('run_stop-live'),
      run_status: sequence(
        { ...answerOf('run_status-trial-succeeded'), run_status: 'running' },
        { ...answerOf('run_status-trial-succeeded'), run_status: 'aborted', driver_alive: null },
      ),
    });
    const result = await store.stopTrials(DRAFT, STARTED - 50, 1_000);
    expect(result).toEqual({ searched: true, runs: [{ runId: RUN, outcome: 'stopped' }], detail: `${RUN} stopped` });
    expect(apb.callsTo('run_stop').map((call) => call.args)).toEqual([{ run_id: RUN }]);
  });

  test('a run that never ends is reported unconfirmed by the deadline', async () => {
    const { store } = authoring({
      runs_list: async () => liveRuns(),
      run_stop: async () => answerOf('run_stop-live'),
      run_status: async () => ({ ...answerOf('run_status-trial-succeeded'), run_status: 'running' }),
    });
    const started = performance.now();
    const result = await store.stopTrials(DRAFT, STARTED - 50, 150);
    expect(result.runs).toEqual([{ runId: RUN, outcome: 'unconfirmed' }]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test.each([
    [
      'a failed listing',
      async () => {
        throw new McpToolError('runs_list', 'engine error');
      },
    ],
    ['a listing that never answers', async () => never()],
  ])('%s reports the runs as not searched', async (_name, handler: FakeHandler) => {
    const { store } = authoring({ runs_list: handler });
    const result = await store.stopTrials(DRAFT, STARTED - 50, 1_000);
    expect(result.searched).toBe(false);
    expect(result.runs).toEqual([]);
  });
});

describe('validation', () => {
  test('an issue APB marks as a warning does not block; any other issue does', async () => {
    const warning = { code: 'V19', message: 'node `write` has no expected_duration', node: 'write', severity: 'warning' };
    const error = { code: 'V12', message: 'edge to nowhere', node: 'write', severity: 'error' };
    const { store } = authoring({
      playbook_validate: sequence({ valid: true, issues: [warning] }, { valid: true, issues: [warning, error] }),
    });
    expect(await store.validate(DRAFT)).toEqual({ ok: true, problems: [], warnings: ['V19: node `write` has no expected_duration'] });
    expect((await store.validate(DRAFT)).problems).toEqual(['V12: edge to nowhere']);
  });
});
