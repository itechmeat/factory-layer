/**
 * Failure paths of the Brain port over the decider that an end-to-end run
 * cannot reproduce on demand: a failed attempt rejects with the port's
 * error carrying priced, attributed usage; a cancellation stays
 * `cancelled`; an invented playbook is refused by the submit schema; a
 * re-plan that drops or rewrites an integrated task still keeps it; a
 * `replan` answer is passed to the core, which enforces the budget, and the
 * message says when none is allowed; a rebind names only a configured
 * profile; a derived acceptance check that does not quote the spec or
 * takes an example check id is refused; the acceptance review may object
 * only to its candidate checks; a playbook review needs a reason and sees
 * the trial output redacted.
 */

import { describe, expect, test } from 'bun:test';

import { AcceptanceCheckSchema } from '../../domain/acceptance';
import type { Plan, PlanTask } from '../../domain/plan';
import { makeSpec } from '../../domain/spec';
import { BrainError } from '../../ports/brain';
import type { CostTable } from '../../ports/cost-table';
import { DecisionError, type DecisionFailure, type DecisionRequest, type DecisionResult } from './decision';
import { type Decider, MozaikBrain } from './mozaik-brain';
import { PlanSubmissionSchema } from './submit-schemas';

const SPEC = makeSpec({ markdown: '# wc\n\nCount words.', sourceFile: 'wc.md' });
const COSTS: CostTable = {
  price: (model) =>
    model === 'glm-5.3-flash'
      ? { available: true, inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 }
      : { available: false, reason: `no price for ${model}` },
};
const CALL = { at: '2026-10-30T10:00:00.000Z', role: 'architect', provider: 'zai', model: 'glm-5.3-flash', elapsedMs: 5 } as const;

/** A decider whose model submits `submitted`, parsed by the decision's own submit schema as a real submission is. */
function submitting(submitted: unknown): Decider {
  return {
    decide: async <T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> => ({ value: request.schema.parse(submitted), usage: [] }),
  };
}

function failing(reason: DecisionFailure): Decider {
  return {
    decide: async () => {
      throw new DecisionError({
        reason,
        role: 'architect',
        detail: 'boom',
        retryable: reason !== 'cancelled',
        usage: [
          {
            ...CALL,
            usage: { kind: 'measured', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            reportedModel: 'glm-5.3-flash',
          },
          { ...CALL, usage: { kind: 'unavailable', reason: 'call_failed' }, failure: 'rate_limit' },
        ],
      });
    },
  };
}

describe('failures', () => {
  test('a failed attempt rejects with BrainError carrying priced usage records of its decision kind', async () => {
    const error: unknown = await new MozaikBrain({ decider: failing('step_limit'), costs: COSTS, replanBudget: 1 })
      .plan(SPEC, [], AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);
    if (!(error instanceof BrainError)) throw new Error('expected a BrainError');
    expect(error.reason).toBe('failed');
    expect(error.usage).toEqual([
      {
        at: CALL.at,
        source: 'brain',
        provider: 'zai',
        model: 'glm-5.3-flash',
        modelSource: 'actual',
        usage: { status: 'measured', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: { status: 'priced', amountUsd: 1, basis: 'computed' },
        decisionKind: 'plan',
      },
      {
        at: CALL.at,
        source: 'brain',
        provider: 'zai',
        model: 'glm-5.3-flash',
        modelSource: 'expected',
        usage: { status: 'unavailable', reason: 'call_failed: rate_limit' },
        cost: { status: 'unavailable', reason: 'call_failed: rate_limit' },
        decisionKind: 'plan',
      },
    ]);
  });

  test.each(['cancelled', 'timeout'] as const)('a %s attempt keeps its reason', async (reason) => {
    const brain = new MozaikBrain({ decider: failing(reason), costs: COSTS, replanBudget: 1 });
    await expect(brain.deriveAcceptance(SPEC, AbortSignal.timeout(1000))).rejects.toMatchObject({ name: 'BrainError', reason });
  });
});

describe('plans the hands can run', () => {
  test('an invented playbook is refused back to the model with the allowed names', () => {
    const parsed = PlanSubmissionSchema.safeParse({
      tasks: [{ id: 'a', title: 't', description: 'd', playbook: 'deploy', ownedPaths: [], dependsOn: [] }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('build-task');
  });

  test('a re-plan keeps integrated tasks as they were, even when the model rewrote or dropped them', async () => {
    const task = { title: 't', description: 'd', ownedPaths: [], dependsOn: [] };
    const current: Plan = {
      tasks: [
        { ...task, id: 'setup', revision: 1, playbook: 'build-task', ownedPaths: ['package.json'] },
        { ...task, id: 'core', revision: 2, playbook: 'build-task', dependsOn: ['setup'] },
        { ...task, id: 'cli', revision: 1, playbook: 'build-task', dependsOn: ['core'] },
      ],
    };
    const submitted = {
      tasks: [
        { ...task, id: 'core', playbook: 'build-task', description: 'rewritten', dependsOn: ['setup'] },
        { ...task, id: 'cli', playbook: 'build-task', description: 'changed', dependsOn: ['core'] },
        { ...task, id: 'docs', playbook: 'build-task', dependsOn: ['cli'] },
      ],
    };
    const brain = new MozaikBrain({ decider: submitting(submitted), costs: COSTS, replanBudget: 1 });
    const failure = { taskId: 'cli', revision: 1, attempt: 3, nodeId: null, reason: 'node_failed', detail: 'x', failingCheckIds: [] };
    const { decision } = await brain.replan(SPEC, current, failure, ['setup', 'core'], AbortSignal.timeout(1000));
    expect(decision.tasks.map((planned) => [planned.id, planned.revision, planned.description])).toEqual([
      ['setup', 1, 'd'],
      ['core', 2, 'd'],
      ['cli', 2, 'changed'],
      ['docs', 1, 'd'],
    ]);
  });
});

describe('MozaikBrain.chooseRecovery, re-plan allowance', () => {
  const task: PlanTask = {
    id: 'cli',
    title: 't',
    description: 'd',
    playbook: 'build-task',
    ownedPaths: ['src/cli.ts'],
    dependsOn: [],
    revision: 1,
  };
  const failure = {
    taskId: 'cli',
    revision: 1,
    attempt: 1,
    nodeId: null,
    reason: 'node_failed',
    detail: 'needs src/x.ts',
    failingCheckIds: [],
  };

  /** A decider that answers `replan` and keeps the user messages it was asked. */
  function replanning(): { decider: Decider; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      decider: {
        decide: async <T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> => {
          asked.push(request.user);
          return { value: request.schema.parse({ choice: 'replan' }), usage: [] };
        },
      },
    };
  }

  test('a replan answer passes unchanged (the core enforces the budget) and the message states the budget', async () => {
    const { decider, asked } = replanning();
    const brain = new MozaikBrain({ decider, costs: COSTS, replanBudget: 1 });
    const first = await brain.chooseRecovery(task, failure, [], AbortSignal.timeout(1000));
    const second = await brain.chooseRecovery(task, failure, [], AbortSignal.timeout(1000));
    expect([first.decision, second.decision]).toEqual([{ choice: 'replan' }, { choice: 'replan' }]);
    expect(asked[1]).not.toContain('Do not choose replan');
    const none = replanning();
    await new MozaikBrain({ decider: none.decider, costs: COSTS, replanBudget: 0 }).chooseRecovery(
      task,
      failure,
      [],
      AbortSignal.timeout(1000),
    );
    expect(none.asked[0]).toContain('Do not choose replan');
  });

  test('rebind accepts only a configured profile, and the message lists them', async () => {
    const asked: string[] = [];
    const answers: unknown[] = [];
    const decider: Decider = {
      decide: async <T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> => {
        asked.push(request.user);
        answers.push(request.schema.safeParse({ choice: 'rebind', profile: 'codex', hint: 'h' }).success);
        return { value: request.schema.parse({ choice: 'rebind', profile: 'claude', hint: 'h' }), usage: [] };
      },
    };
    const { decision } = await new MozaikBrain({ decider, costs: COSTS, replanBudget: 1 }).chooseRecovery(
      task,
      failure,
      [],
      AbortSignal.timeout(1000),
    );
    expect(answers).toEqual([false]);
    expect(decision).toEqual({ choice: 'rebind', profile: 'claude', hint: 'h' });
    expect(asked[0]).toContain('claude');
  });
});

describe('judge', () => {
  test('the executor report reaches the model redacted of the secrets', async () => {
    const asked: string[] = [];
    const decider: Decider = {
      decide: async <T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> => {
        asked.push(request.user);
        return { value: request.schema.parse({ outcome: 'accept' }), usage: [] };
      },
    };
    const brain = new MozaikBrain({ decider, costs: COSTS, replanBudget: 1, secrets: ['sk-leaked-in-report'] });
    const task: PlanTask = {
      id: 'cli',
      title: 't',
      description: 'd',
      playbook: 'build-task',
      ownedPaths: ['a'],
      dependsOn: [],
      revision: 1,
    };
    const report = { runId: 'r', status: 'succeeded' as const, summary: 'printed sk-leaked-in-report', nodes: [], usage: [] };
    await brain.judge(task, report, [], AbortSignal.timeout(1000)).catch(() => undefined);
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('sk-leaked-in-report');
  });
});

describe('acceptance', () => {
  const spec = makeSpec({
    markdown: ['# upcase', '', 'Prints its input in upper case.', '', '```', "$ printf 'a\\n' | upcase", 'A', '```', ''].join('\n'),
    sourceFile: 'upcase.md',
  });
  const derived = { kind: 'cli', id: 'upper', description: 'upper case', args: [], stdin: 'b\n', expectedExitCode: 0 };

  /** A decider that records each request and parses `submitted` with its schema. */
  function recording(submitted: unknown): { readonly decider: Decider; readonly requests: DecisionRequest<unknown>[] } {
    const requests: DecisionRequest<unknown>[] = [];
    return {
      requests,
      decider: {
        decide: async <T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> => {
          requests.push(request);
          return { value: request.schema.parse(submitted), usage: [] };
        },
      },
    };
  }

  test('a derived check whose source is not a quote of the spec is refused back to the model, naming the check', async () => {
    const { decider } = recording({ checks: [{ ...derived, source: 'Prints its input in capitals.' }] });
    const error: unknown = await new MozaikBrain({ decider, costs: COSTS, replanBudget: 1 })
      .deriveAcceptance(spec, AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain('check upper: the source is not a verbatim quote of the spec');
  });

  test('a derived check that quotes the spec passes; the message lists the example checks not to repeat', async () => {
    const { decider, requests } = recording({ checks: [{ ...derived, source: 'Prints its input\n in upper case.' }] });
    const answer = await new MozaikBrain({ decider, costs: COSTS, replanBudget: 1 }).deriveAcceptance(spec, AbortSignal.timeout(1000));
    expect(answer.decision.map((check) => check.id)).toEqual(['upper']);
    expect(requests[0]?.user).toContain('spec-example-1');
  });

  test('a derived check may not take an example check id', () => {
    const { decider } = recording({ checks: [{ ...derived, id: 'spec-example-9', source: 'Prints its input in upper case.' }] });
    const brain = new MozaikBrain({ decider, costs: COSTS, replanBudget: 1 });
    return expect(brain.deriveAcceptance(spec, AbortSignal.timeout(1000))).rejects.toThrow('reserved for the spec example checks');
  });

  test('the review is a Critic decision that may object only to the candidate checks', async () => {
    const check = AcceptanceCheckSchema.parse(derived);
    const ok = recording({ objections: [{ checkId: 'upper', reason: 'the spec prints B' }] });
    const answer = await new MozaikBrain({ decider: ok.decider, costs: COSTS, replanBudget: 1 }).reviewAcceptance(
      spec,
      [],
      [check],
      [],
      AbortSignal.timeout(1000),
    );
    expect(answer.decision).toEqual([{ checkId: 'upper', reason: 'the spec prints B' }]);
    expect(ok.requests[0]?.role).toBe('critic');
    const unknown = recording({ objections: [{ checkId: 'ghost', reason: 'no' }] });
    const brain = new MozaikBrain({ decider: unknown.decider, costs: COSTS, replanBudget: 1 });
    await expect(brain.reviewAcceptance(spec, [], [check], [], AbortSignal.timeout(1000))).rejects.toThrow('unknown check id ghost');
  });
});

describe('playbook review', () => {
  const playbook = { id: 'authored-readme-x-d1', name: 'Readme', content: 'id: authored-readme-x-d1' };

  test('a review without reasons is refused back to the model', () => {
    const brain = new MozaikBrain({ decider: submitting({ verdict: 'approve', reasons: [] }), costs: COSTS, replanBudget: 1 });
    return expect(
      brain.reviewPlaybook(playbook, { ok: true, problems: [], warnings: [] }, { ok: true, output: '' }, AbortSignal.timeout(1000)),
    ).rejects.toThrow('reasons');
  });

  test('the trial output reaches the Critic redacted of the secrets', async () => {
    const requests: DecisionRequest<unknown>[] = [];
    const decider: Decider = {
      decide: async <T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> => {
        requests.push(request);
        return { value: request.schema.parse({ verdict: 'reject', reasons: ['no'] }), usage: [] };
      },
    };
    const brain = new MozaikBrain({ decider, costs: COSTS, replanBudget: 1, secrets: ['sk-leaked-in-trial'] });
    await brain.reviewPlaybook(
      playbook,
      { ok: true, problems: [], warnings: [] },
      { ok: true, output: 'printed sk-leaked-in-trial' },
      AbortSignal.timeout(1000),
    );
    expect(requests[0]?.role).toBe('critic');
    expect(requests[0]?.user).not.toContain('sk-leaked-in-trial');
  });
});
