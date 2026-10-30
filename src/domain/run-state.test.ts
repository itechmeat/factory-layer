import { describe, expect, test } from 'bun:test';

import { RunStateSchema, makeDispatchKey } from './run-state';

const INSTANT = '2026-01-15T09:00:00.000Z';
const END_INSTANT = '2026-01-15T10:00:00.000Z';
const DISPATCH_KEY = 'run-2026-01-15-todo-cli|api|r2|a1';

/** One supervised executor run of the state, keyed by its dispatch key. */
function runFixture() {
  return {
    executorRunId: 'apb-run-42',
    taskId: 'api',
    revision: 2,
    attempt: 1,
    dispatchKey: DISPATCH_KEY,
    playbook: 'feature',
    tree: 'tree-api-r2',
    role: 'task',
    supervisorToken: 'supervisor-token-1',
    cursor: 12,
    lastEventAt: INSTANT,
    state: 'live',
  };
}

/** A RunState literal holding every section: plan, checks, options, cutoff, a live run, one intent of every kind. */
function fullState() {
  return {
    schemaVersion: 1,
    runId: 'run-2026-01-15-todo-cli',
    spec: { name: 'todo-cli', markdown: '# Todo', sourceFile: 'todo-cli.md' },
    plan: {
      tasks: [
        {
          id: 'api',
          revision: 2,
          title: 'HTTP API',
          description: 'Serve the API.',
          playbook: 'feature',
          ownedPaths: ['src/api'],
          dependsOn: [],
        },
      ],
    },
    acceptanceChecks: [
      {
        kind: 'cli',
        id: 'cli-exit',
        description: 'exits zero on --help',
        timeoutMs: 30_000,
        args: ['--help'],
        expectedExitCode: 0,
      },
    ],
    acceptanceUnavailable: false,
    options: { requiredRuntimes: ['bun', 'npm'], deliverUnverified: false },
    cutoffAtMs: 1_768_492_800_000,
    replansUsed: 1,
    tasks: { api: { revision: 2, state: 'running', attemptsUsed: 1 } },
    runs: { [DISPATCH_KEY]: runFixture() },
    intents: [
      {
        kind: 'start',
        dispatchKey: DISPATCH_KEY,
        taskId: 'api',
        revision: 2,
        attempt: 1,
        playbook: 'feature',
        tree: 'tree-api-r2',
        at: INSTANT,
        request: { taskId: 'api', role: 'task', playbook: 'feature', inputs: { taskText: 'api', ownedPaths: ['src/api'] } },
      },
      {
        kind: 'command',
        executorRunId: 'apb-run-42',
        taskId: 'api',
        revision: 2,
        attempt: 1,
        choice: 'retry',
        nodeId: 'implement',
        hint: 'check the imports',
        profile: null,
        steps: [{ step: 'append_context', postedSeq: 3 }, { step: 'retry_node' }],
      },
      {
        kind: 'stop',
        executorRunId: 'apb-run-42',
        taskId: 'api',
        purpose: 'recovery',
        continuation: { do: 'resume_recovery', taskId: 'api', revision: 2, attempt: 1, reason: 'stalled', detail: 'no event' },
        requestedAt: INSTANT,
        confirmed: false,
      },
      { kind: 'integrate', taskId: 'api', revision: 2, commit: 'abc1234', base: 'def5678', checks: [] },
      { kind: 'deliver', at: INSTANT },
    ],
    abandonedTrees: [],
    lastMainChecks: [{ checkId: 'cli-exit', status: 'passed', reasons: [], detail: '' }],
    outcome: 'partial',
    startedAt: INSTANT,
    endedAt: END_INSTANT,
  };
}

describe('makeDispatchKey', () => {
  test('joins run, task, revision and attempt in the dispatch key format', () => {
    expect(makeDispatchKey('run-2026-01-15-todo-cli', 'api', 2, 1)).toBe(DISPATCH_KEY);
  });
});

describe('RunStateSchema', () => {
  test('rejects an unknown intent kind', () => {
    const state = { ...fullState(), intents: [{ kind: 'teleport', at: INSTANT }] };
    expect(RunStateSchema.safeParse(state).success).toBe(false);
  });

  test('rejects a missing schemaVersion, naming the path', () => {
    const { schemaVersion: _omitted, ...state } = fullState();
    const parsed = RunStateSchema.safeParse(state);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toContain('schemaVersion');
  });

  test('rejects a negative cursor', () => {
    const state = fullState();
    state.runs = { [DISPATCH_KEY]: { ...runFixture(), cursor: -1 } };
    expect(RunStateSchema.safeParse(state).success).toBe(false);
  });
});

describe('domain index re-exports', () => {});
