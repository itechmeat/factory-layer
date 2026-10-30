import { describe, expect, test } from 'bun:test';

import { AUTHORING_APPROVE_MARGIN_MS, AUTHORING_FLOW_DEADLINE_MS, AUTHORING_TRIAL_DEADLINE_MS, type PlaybookDraft } from '../domain';
import { authorPlaybook, type AuthoringOutcome, FORMAT_PLAYBOOK_ID } from './author-playbook';
import { drive } from './testing/drive';
import { type FakePorts, fakePorts } from './testing/fake-ports';

const D1 = 'authored-readme-s1-d1';
const D2 = 'authored-readme-s1-d2';

/** A draft the policy allows; `extra` YAML lines go under `nodes`. */
function draft(id: string, extraNodes = ''): PlaybookDraft {
  const content = [
    'schema: 2',
    `id: ${id}`,
    'name: Write a README',
    'version: 1.0.0',
    'params: []',
    'defaults:',
    '  profile: { name: claude, scope: auto }',
    'effects: [fs_read, fs_write]',
    'nodes:',
    '  - { id: start, type: start }',
    "  - { id: write, type: agent_task, prompt: 'Write it: {{run.instruction}}' }",
    '  - { id: finish, type: finish, outcome: success }',
    extraNodes,
    'edges:',
    '  - { from: start, to: write }',
    '  - { from: write, to: finish }',
  ].join('\n');
  return { name: 'Write a README', description: 'Writes a README', content };
}

const SCRIPT_NODE = '  - { id: sh, type: script, script: scripts/x.sh, runner: sh }';

function setUp(): FakePorts {
  const ports = fakePorts();
  ports.playbooks.seed({ id: FORMAT_PLAYBOOK_ID, name: 'Implement a task', content: 'id: implement-task' });
  ports.brain.script.playbook_review.defaultAnswer({ decision: { verdict: 'approve', reasons: ['the trial wrote the README'] } });
  return ports;
}

function author(ports: FakePorts): Promise<AuthoringOutcome> {
  return drive(
    ports.clock,
    authorPlaybook(ports, {
      runId: 'author-readme-1',
      taskKind: 'readme',
      suffix: 's1',
      example: { examples: ['write a README for a'], trialInstruction: 'Write it for b.' },
      secrets: [],
    }),
  );
}

function approvedIds(ports: FakePorts): string[] {
  return ports.playbooks.calls.flatMap((call) => (call.method === 'approve' ? [call.id] : []));
}

describe('authorPlaybook', () => {
  test('approved by the brain: approved in APB under its assigned id, each step traced in order', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft('anything') });
    const outcome = await author(ports);
    expect(outcome).toMatchObject({ result: 'approved', playbookId: D1, reasons: ['the trial wrote the README'] });
    expect(approvedIds(ports)).toEqual([D1]);
    expect(outcome.steps.map((step) => step.step)).toEqual([
      'format',
      'draft',
      'policy',
      'create',
      'validate',
      'trial',
      'review',
      'recheck',
      'approve',
    ]);
    expect(ports.sink.ofType('authoring_ended').map((event) => [event.result, event.playbookId])).toEqual([['approved', D1]]);
    const trial = ports.playbooks.calls.find((call) => call.method === 'trial');
    expect(trial).toMatchObject({ id: D1, instruction: 'Write it for b.' });
  });

  test('a draft naming an existing playbook is stored under its assigned id instead', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(FORMAT_PLAYBOOK_ID) });
    expect((await author(ports)).playbookId).toBe(D1);
    expect((await ports.playbooks.get(FORMAT_PLAYBOOK_ID)).content).toBe('id: implement-task');
  });

  test('the Critic approving a failed trial does not approve the playbook', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(D1) });
    ports.playbooks.setTrial(D1, { ok: false, output: 'the agent failed' });
    const outcome = await author(ports);
    expect(outcome.result).toBe('rejected');
    expect(approvedIds(ports)).toEqual([]);
  });

  test('a draft that fails validation is corrected once under a new id; the first stays unapproved', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(D1) });
    ports.brain.script.playbook.answerWith({ decision: draft(D2) });
    ports.playbooks.setValidation(D1, { ok: false, problems: ['V12: edge to nowhere'], warnings: [] });
    const outcome = await author(ports);
    expect(outcome).toMatchObject({ result: 'approved', playbookId: D2 });
    expect(approvedIds(ports)).toEqual([D2]);
    const correction = ports.brain.callsOf('playbook')[1]?.args['request'];
    expect(correction).toMatchObject({ playbookId: D2, correction: { issues: ['V12: edge to nowhere'] } });
  });

  test('a draft breaking the policy twice is never stored and the flow ends rejected', async () => {
    const ports = setUp();
    ports.brain.script.playbook.defaultAnswer({ decision: draft(D1, SCRIPT_NODE) });
    const outcome = await author(ports);
    expect(outcome.result).toBe('rejected');
    expect(ports.playbooks.calls.filter((call) => call.method === 'create')).toEqual([]);
    expect(ports.brain.callsOf('playbook')).toHaveLength(2);
  });

  test('a create refused by APB goes back to the Architect with the refusal', async () => {
    const ports = setUp();
    ports.brain.script.playbook.defaultAnswer({ decision: draft(D1) });
    ports.playbooks.refuseCreate(D1, 'schema error');
    ports.playbooks.refuseCreate(D2, 'schema error');
    expect((await author(ports)).result).toBe('rejected');
    expect(ports.brain.callsOf('playbook')[1]?.args['request']).toMatchObject({
      correction: { issues: [expect.stringContaining('schema error')] },
    });
  });

  test('no draft answer ends the flow none', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: null });
    expect((await author(ports)).result).toBe('none');
  });

  test('a trial that does not answer in time has its run stopped and the flow ends failed naming it', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(D1) });
    ports.playbooks.setTrial(D1, () => new Promise(() => {}));
    ports.playbooks.setStopResult({ searched: true, runs: [{ runId: `${D1}-1700`, outcome: 'stopped' }], detail: `${D1}-1700 stopped` });
    const startMs = ports.clock.now().getTime();
    const outcome = await author(ports);
    expect(outcome.result).toBe('failed');
    expect(outcome.detail).toContain(`${D1}-1700`);
    const stop = ports.playbooks.calls.find((call) => call.method === 'stopTrials');
    expect(stop).toMatchObject({ id: D1, notBeforeMs: startMs });
    expect(ports.clock.now().getTime() - startMs).toBe(AUTHORING_TRIAL_DEADLINE_MS);
    expect(approvedIds(ports)).toEqual([]);
  });

  test('an approval that would start inside the margin before the flow deadline is not started', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(D1) });
    const endMs = ports.clock.now().getTime() + AUTHORING_FLOW_DEADLINE_MS;
    const original = ports.playbooks.get.bind(ports.playbooks);
    let gets = 0;
    ports.playbooks.get = async (id) => {
      gets += 1;
      if (gets === 3) await ports.sleep(endMs - AUTHORING_APPROVE_MARGIN_MS / 2 - ports.clock.now().getTime());
      return original(id);
    };
    const outcome = await author(ports);
    expect(outcome.result).toBe('failed');
    expect(outcome.detail).toContain('deadline');
    expect(approvedIds(ports)).toEqual([]);
  });

  test('an approval that ends after the flow deadline reports failed with the approved id', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(D1) });
    const endMs = ports.clock.now().getTime() + AUTHORING_FLOW_DEADLINE_MS;
    const originalGet = ports.playbooks.get.bind(ports.playbooks);
    let gets = 0;
    ports.playbooks.get = async (id) => {
      gets += 1;
      if (gets === 3) await ports.sleep(endMs - 2 * AUTHORING_APPROVE_MARGIN_MS - ports.clock.now().getTime());
      return originalGet(id);
    };
    const originalApprove = ports.playbooks.approve.bind(ports.playbooks);
    ports.playbooks.approve = async (id) => {
      await ports.sleep(3 * AUTHORING_APPROVE_MARGIN_MS);
      return originalApprove(id);
    };
    const outcome = await author(ports);
    expect(approvedIds(ports)).toEqual([D1]);
    expect(outcome).toMatchObject({ result: 'failed', playbookId: D1 });
    expect(outcome.detail).toContain(`approved as ${D1}`);
    expect(outcome.detail).toContain('deadline');
  });

  test('a stored playbook that no longer meets the policy is not approved', async () => {
    const ports = setUp();
    ports.brain.script.playbook.answerWith({ decision: draft(D1) });
    ports.playbooks.setValidation(D1, { ok: true, problems: [], warnings: [] });
    const original = ports.playbooks.validate.bind(ports.playbooks);
    ports.playbooks.validate = async (id) => {
      const result = await original(id);
      ports.playbooks.replaceContent(id, draft(D1, SCRIPT_NODE).content);
      return result;
    };
    const outcome = await author(ports);
    expect(outcome.result).toBe('rejected');
    expect(outcome.steps.find((step) => step.step === 'recheck')?.ok).toBe(false);
    expect(approvedIds(ports)).toEqual([]);
  });
});
