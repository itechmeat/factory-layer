import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';

import { ApbAuthoring } from './apb-authoring';
import { ApbExecutor } from './apb-executor';
import { RunEventsSchema, RunReportSchema } from './apb-report-schemas';
import {
  CommandPostSchema,
  RunStartSchema,
  RunStatusAnswerSchema,
  RunStopSchema,
  RunsListSchema,
  SupervisorWaitSchema,
} from './apb-run-schemas';
import { answerOf, recorded, without } from './testing/apb-fixtures';
import { FakeApb, type FakeHandler } from './testing/fake-apb';

const TOKEN = 'sv-test-token-0123456789';
const tree = mkdtempSync(join(tmpdir(), 'apb-contract-'));
afterAll(() => rmSync(tree, { recursive: true, force: true }));
const FAST = { startMs: 300, callMs: 300, waitMarginMs: 50, lookupMs: 300, pollIntervalMs: 10 };

describe('every recorded APB 1.0.0-beta.1 answer parses with the schema the adapter reads it with', () => {
  const cases: [string, z.ZodType][] = [
    ['playbook_run-started', RunStartSchema],
    ['playbook_run-untrusted', RunStartSchema],
    ['supervisor_wait_event-node-failed', SupervisorWaitSchema],
    ['supervisor_wait_event-node-failed-after-retry', SupervisorWaitSchema],
    ['supervisor_wait_event-parked', SupervisorWaitSchema],
    ['supervisor_wait_event-ended', SupervisorWaitSchema],
    ['supervisor_wait_event-timeout', SupervisorWaitSchema],
    ['supervisor_context_append', CommandPostSchema],
    ['supervisor_node_retry', CommandPostSchema],
    ['run_stop-live', RunStopSchema],
    ['run_status-parked', RunStatusAnswerSchema],
    ['run_status-aborted', RunStatusAnswerSchema],
    ['run_status-aborted-driver-exiting', RunStatusAnswerSchema],
    ['run_status-succeeded', RunStatusAnswerSchema],
    ['run_status-agent-succeeded', RunStatusAnswerSchema],
    ['runs_list', RunsListSchema],
    ['run_report-aborted', RunReportSchema],
    ['run_report-script-succeeded', RunReportSchema],
    ['run_report-agent-succeeded', RunReportSchema],
    ['run_events-script-retried-stopped', RunEventsSchema],
    ['run_events-agent-succeeded', RunEventsSchema],
  ];
  for (const [name, schema] of cases) {
    test(name, () => {
      expect(schema.safeParse(recorded(name).answer).success).toBe(true);
    });
  }
});

const startedHandler: FakeHandler = async () => ({ ...answerOf('playbook_run-started'), supervisor_token: TOKEN });

async function startedExecutor(handlers: Record<string, FakeHandler>): Promise<ApbExecutor> {
  const executor = new ApbExecutor(async () => new FakeApb({ playbook_run: startedHandler, ...handlers }), FAST);
  await executor.startRun({ dispatchKey: 'k', playbook: 'implement-task', tree, inputs: { taskText: 't', ownedPaths: ['a'] } });
  return executor;
}

const RUN_ID = 'smoke-fail-1793367583063';

describe('a recorded answer that loses a field the adapter reads fails with a validation error naming the tool', () => {
  test('playbook_run without run_id: the start is indeterminate, naming the tool', async () => {
    const executor = new ApbExecutor(
      async () => new FakeApb({ playbook_run: async () => without('playbook_run-started', [], 'run_id') }),
      FAST,
    );
    const result = await executor.startRun({
      dispatchKey: 'k',
      playbook: 'implement-task',
      tree,
      inputs: { taskText: 't', ownedPaths: ['a'] },
    });
    expect(result).toMatchObject({ ok: false, outcome: 'indeterminate' });
    expect(!result.ok && result.detail).toContain('MCP tool "playbook_run" returned an unexpected result');
  });

  const executorCases: { tool: string; field: string; act: () => Promise<unknown> }[] = [
    {
      tool: 'supervisor_wait_event',
      field: 'run_status',
      act: async () =>
        (
          await startedExecutor({ supervisor_wait_event: async () => without('supervisor_wait_event-node-failed', [], 'run_status') })
        ).waitEvent(RUN_ID, 0, 100),
    },
    {
      tool: 'supervisor_wait_event',
      field: 'wake.seq',
      act: async () =>
        (
          await startedExecutor({ supervisor_wait_event: async () => without('supervisor_wait_event-node-failed', ['wake'], 'seq') })
        ).waitEvent(RUN_ID, 0, 100),
    },
    {
      tool: 'supervisor_node_retry',
      field: 'posted_seq',
      act: async () =>
        (await startedExecutor({ supervisor_node_retry: async () => without('supervisor_node_retry', [], 'posted_seq') })).retryNode(
          RUN_ID,
          'boom',
        ),
    },
    {
      tool: 'runs_list',
      field: 'started_ts',
      act: () =>
        new ApbExecutor(async () => new FakeApb({ runs_list: async () => without('runs_list', [0], 'started_ts') }), FAST).findRuns({
          playbook: 'smoke-wait',
          tree,
          notBefore: new Date(0).toISOString(),
        }),
    },
    {
      tool: 'run_status',
      field: 'worktree',
      act: () =>
        new ApbExecutor(
          async () =>
            new FakeApb({
              runs_list: async () => recorded('runs_list').answer,
              run_status: async () => without('run_status-succeeded', [], 'worktree'),
            }),
          FAST,
        ).findRuns({ playbook: 'smoke-wait', tree, notBefore: new Date(0).toISOString() }),
    },
    {
      tool: 'run_report',
      field: 'outcome',
      act: () =>
        new ApbExecutor(
          async () => new FakeApb({ run_report: async () => without('run_report-agent-succeeded', [], 'outcome') }),
          FAST,
        ).report('r'),
    },
    {
      tool: 'run_events',
      field: 'attempt_finished.node',
      act: () =>
        new ApbExecutor(
          async () =>
            new FakeApb({
              run_report: async () => recorded('run_report-agent-succeeded').answer,
              run_events: async () => without('run_events-agent-succeeded', ['events', 10], 'node'),
            }),
          FAST,
        ).report('r'),
    },
  ];
  for (const { tool, field, act } of executorCases) {
    test(`${tool} without ${field}`, async () => {
      const failure = await act().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ name: 'ExecutorError', reason: 'protocol' });
      expect(failure instanceof Error && failure.message).toContain(`"${tool}"`);
    });
  }

  const authoringCases: { tool: string; field: string; act: (authoring: ApbAuthoring) => Promise<unknown>; answer: unknown }[] = [
    { tool: 'playbook_list', field: 'name', act: (authoring) => authoring.list(), answer: without('playbook_list', [0], 'name') },
    {
      tool: 'playbook_get',
      field: 'yaml',
      act: (authoring) => authoring.get('implement-task'),
      answer: without('playbook_get-full', [], 'yaml'),
    },
    {
      tool: 'playbook_validate',
      field: 'valid',
      act: (authoring) => authoring.validate('implement-task'),
      answer: without('playbook_validate', [], 'valid'),
    },
    {
      tool: 'playbook_approve',
      field: 'trusted',
      act: (authoring) => authoring.approve('smoke'),
      answer: without('playbook_approve', [], 'trusted'),
    },
  ];
  for (const { tool, field, act, answer } of authoringCases) {
    test(`${tool} without ${field}`, async () => {
      const authoring = new ApbAuthoring(async () => new FakeApb({ [tool]: async () => answer }), { callMs: 300 });
      await expect(act(authoring)).rejects.toThrow(`MCP tool "${tool}" returned an unexpected result`);
    });
  }
});
