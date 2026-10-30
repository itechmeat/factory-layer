import { describe, expect, test } from 'bun:test';

import { authoredPlaybookId, authoringPolicyIssues, parseAuthoringExample, PlaybookReviewSchema } from './authoring';

const NODES: Record<string, unknown>[] = [
  { id: 'start', type: 'start' },
  { id: 'write', type: 'agent_task', prompt: 'Write it: {{run.instruction}}', profile: null, connectors: [], interactive: false },
  { id: 'finish', type: 'finish', outcome: 'success' },
];

/** A draft the policy allows: one agent step on the claude profile. */
function allowed(): Record<string, unknown> {
  return {
    schema: 2,
    id: 'authored-readme-x-d1',
    name: 'Write a README',
    version: '1.0.0',
    params: [],
    defaults: { profile: { name: 'claude', scope: 'auto' } },
    effects: ['fs_read', 'fs_write'],
    nodes: NODES,
    edges: [
      { from: 'start', to: 'write' },
      { from: 'write', to: 'finish' },
    ],
  };
}

function withNode(node: Record<string, unknown>): Record<string, unknown> {
  return { ...allowed(), nodes: [...NODES, node] };
}

describe('authoringPolicyIssues refuses what an authored playbook may not do', () => {
  test('the allowed draft has no issues', () => {
    expect(authoringPolicyIssues(allowed(), 'authored-readme-x-d1')).toEqual([]);
  });

  test.each([
    ['a script node', withNode({ id: 'sh', type: 'script', script: 'scripts/x.sh', runner: 'sh' })],
    ['a sub-playbook node', withNode({ id: 'child', type: 'playbook', playbook: 'deploy' })],
    ['a human review gate', withNode({ id: 'gate', type: 'human_review' })],
    ['an agent node on another profile', withNode({ id: 'other', type: 'agent_task', prompt: 'x', profile: 'codex' })],
    ['an agent node with a connector', withNode({ id: 'mail', type: 'agent_task', prompt: 'x', profile: 'claude', connectors: ['gmail'] })],
    ['an agent node with a workdir', withNode({ id: 'w', type: 'agent_task', prompt: 'x', profile: 'claude', workdir: '/etc' })],
    ['an interactive agent node', withNode({ id: 'i', type: 'agent_task', prompt: 'x', profile: 'claude', interactive: true })],
    ['an unknown node field', withNode({ id: 'u', type: 'agent_task', prompt: 'x', profile: 'claude', hooks: ['rm'] })],
    ['the secrets effect', { ...allowed(), effects: ['fs_read', 'secrets'] }],
    ['the irreversible effect', { ...allowed(), effects: ['irreversible'] }],
    ['a supervisor', { ...allowed(), supervisor: { playbook: 'watch' } }],
    ['a goal script check', { ...allowed(), goal: { criteria: [{ description: 'x', check: { type: 'script', path: 'scripts/a.sh' } }] } }],
    ['an unknown top-level field', { ...allowed(), hooks: { before: 'curl x' } }],
    ['a param without a default', { ...allowed(), params: [{ name: 'dir', type: 'string' }] }],
    ['a default profile that is not claude', { ...allowed(), defaults: { profile: { name: 'codex' } } }],
    ['another id', { ...allowed(), id: 'implement-task' }],
    ['no nodes', { ...allowed(), nodes: 'start' }],
    ['not an object', 'nodes: []'],
  ])('%s', (_name, draft) => {
    expect(authoringPolicyIssues(draft, 'authored-readme-x-d1').length).toBeGreaterThan(0);
  });

  test('the fields APB fills in when it stores a playbook are allowed', () => {
    const stored = {
      id: 'write',
      title: null,
      expected_duration: '10m',
      inputs: null,
      outputs: { files: [], fields: ['summary'] },
      cache: null,
      type: 'agent_task',
      prompt: 'x',
      profile: null,
      max_retries: null,
      timeout_seconds: 900,
      workdir: null,
      isolation: null,
      connectors: [],
      interactive: false,
    };
    const draft = {
      ...allowed(),
      supervisor: null,
      requires: null,
      nodes: [{ id: 'start', type: 'start', title: null, cache: null }, stored],
    };
    expect(authoringPolicyIssues(draft, 'authored-readme-x-d1')).toEqual([]);
  });

  test('an agent node with no profile and no default profile is refused', () => {
    const draft = { ...allowed(), defaults: {} };
    expect(authoringPolicyIssues(draft, 'authored-readme-x-d1')).toContain('node write: the agent node must run on the claude profile');
  });
});

describe('authoredPlaybookId', () => {
  test('names the kind, the run suffix and the draft attempt', () => {
    expect(authoredPlaybookId('readme', 'mf3k2a', 2)).toBe('authored-readme-mf3k2a-d2');
  });
});

describe('PlaybookReviewSchema', () => {
  test('a review without reasons is refused', () => {
    expect(PlaybookReviewSchema.safeParse({ verdict: 'approve', reasons: [] }).success).toBe(false);
  });
});

describe('parseAuthoringExample', () => {
  test('reads the examples and the trial instruction', () => {
    const example = parseAuthoringExample(
      [
        '# Readme',
        '',
        '## Examples',
        '',
        '- write a README for a',
        '- write a README for b',
        '',
        '## Trial',
        '',
        'Write it for c.',
        '',
      ].join('\n'),
    );
    expect(example).toEqual({ examples: ['write a README for a', 'write a README for b'], trialInstruction: 'Write it for c.' });
  });

  test.each([
    ['no examples', '## Trial\n\nDo it.\n'],
    ['no trial', '## Examples\n\n- one\n'],
    ['an empty trial', '## Examples\n\n- one\n\n## Trial\n\n'],
  ])('%s is refused', (_name, markdown) => {
    expect(() => parseAuthoringExample(markdown)).toThrow(RangeError);
  });
});
