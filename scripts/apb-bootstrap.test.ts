import { describe, expect, test } from 'bun:test';

import {
  APB_CLI_TIMEOUT_MS,
  apbExitFailure,
  BootstrapError,
  checkApproval,
  checkProfileWrite,
  parseJsonOutput,
  parseProfileYaml,
  profileWriteArgs,
  projectTrustLines,
  ProfileShowSchema,
} from './apb-bootstrap';

const PROFILE_YAML = `name: coder
description: 'Factory coding agent: writes code'
executor:
  agent: claude
  model: model-a
  fallbacks:
  - agent: codex
    model: model-b
soul: any
skills: []
`;

describe('parseProfileYaml', () => {
  test('a malformed profile is a typed failure naming the profile', () => {
    expect(() => parseProfileYaml('coder', 'name: coder\n')).toThrow(BootstrapError);
    expect(() => parseProfileYaml('coder', 'name: coder\n')).toThrow(/coder/);
  });
});

describe('profileWriteArgs', () => {
  test('rebuilds the write from the profile with the digest it must match', () => {
    const profile = parseProfileYaml('coder', PROFILE_YAML);
    expect(profileWriteArgs(profile, 'profiles/coder/SOUL.md', 'sha256:abc')).toEqual([
      'profile',
      'write',
      'coder',
      '--agent',
      'claude',
      '--model',
      'model-a',
      '--fallback',
      'codex:model-b',
      '--soul',
      'profiles/coder/SOUL.md',
      '--soul-requirement',
      'any',
      '--description',
      'Factory coding agent: writes code',
      '--expected-digest',
      'sha256:abc',
    ]);
  });

  test('passes every skill on', () => {
    const profile = { ...parseProfileYaml('coder', PROFILE_YAML), skills: ['one', 'two'] };
    const args = profileWriteArgs(profile, 'SOUL.md', 'd');
    expect(args.filter((_arg, index) => args[index - 1] === '--skill')).toEqual(['one', 'two']);
  });
});

describe('checkProfileWrite', () => {
  const ok = { name: 'coder', bundle_digest: 'sha256:b', trusted: true, trust_write_failed: false, warnings: [] };

  test('returns the bundle digest of a trusted write', () => {
    expect(checkProfileWrite('coder', ok)).toBe('sha256:b');
  });

  test('an untrusted write fails', () => {
    expect(() => checkProfileWrite('coder', { ...ok, trusted: false })).toThrow(/not trusted/);
  });

  test('a failed trust write fails', () => {
    expect(() => checkProfileWrite('coder', { ...ok, trust_write_failed: true })).toThrow(/trust store/);
  });

  test('unapproved skills fail and are named', () => {
    expect(() => checkProfileWrite('coder', { ...ok, skills_unapproved: ['web'] })).toThrow(/web/);
  });

  test('an unexpected answer is a typed failure', () => {
    expect(() => checkProfileWrite('coder', { trusted: 'yes' })).toThrow(BootstrapError);
  });
});

describe('checkApproval', () => {
  test('accepts a trusted approval', () => {
    expect(() => checkApproval('smoke', { id: 'smoke', trusted: true, lifecycle: 'active' })).not.toThrow();
  });

  test('rejects an approval that is not trusted', () => {
    expect(() => checkApproval('smoke', { id: 'smoke', trusted: false })).toThrow(/smoke/);
  });

  test('a malformed approval answer keeps the schema problem', () => {
    expect(() => checkApproval('smoke', { id: 'smoke', trusted: 'yes' })).toThrow(
      /unexpected approve answer: .*expected boolean.*at trusted/s,
    );
  });
});

describe('parseJsonOutput', () => {
  test('parses and validates command output', () => {
    expect(parseJsonOutput('profile show', '{"profile_digest":"sha256:x"}', ProfileShowSchema)).toEqual({
      profile_digest: 'sha256:x',
    });
  });

  test('output that is not JSON is a typed failure naming the step', () => {
    expect(() => parseJsonOutput('profile show', 'oops', ProfileShowSchema)).toThrow(/profile show/);
  });
});

describe('projectTrustLines', () => {
  const entries = [
    { kind: 'playbook', id: 'smoke', digest: 'sha256:p1', approved_at_ms: 0, origin_kind: 'agent_generated' },
    { kind: 'playbook', id: 'other', digest: 'sha256:p2', approved_at_ms: 0, origin_kind: 'agent_generated' },
    { kind: 'profile_bundle', id: 'coder', digest: 'sha256:b1', approved_at_ms: 0, origin_kind: 'agent_generated' },
    { kind: 'profile_bundle', id: 'coder', digest: 'sha256:old', approved_at_ms: 0, origin_kind: 'agent_generated' },
  ];

  test('keeps the approved playbooks and the written bundles only', () => {
    const lines = projectTrustLines(entries, { playbookIds: ['smoke'], bundleDigests: ['sha256:b1'] });
    expect(lines).toEqual([
      'playbook        smoke  sha256:p1  1970-01-01T00:00:00.000Z',
      'profile_bundle  coder  sha256:b1  1970-01-01T00:00:00.000Z',
    ]);
  });

  test('fails when an approval is missing from the trust list', () => {
    expect(() => projectTrustLines(entries, { playbookIds: ['smoke-stall'], bundleDigests: [] })).toThrow(/smoke-stall/);
  });
});

describe('apbExitFailure', () => {
  test('a SIGKILL once the timeout has elapsed is the timeout', () => {
    expect(apbExitFailure({ signal: 'SIGKILL', code: null, elapsedMs: APB_CLI_TIMEOUT_MS, stderr: '' })).toBe(
      `apb did not finish within ${APB_CLI_TIMEOUT_MS} ms`,
    );
  });

  test('an early SIGKILL (OOM killer, kill -9) is an outside kill, not the timeout', () => {
    expect(apbExitFailure({ signal: 'SIGKILL', code: null, elapsedMs: 5, stderr: '' })).toBe('apb was killed by SIGKILL');
  });

  test('any other signal is an outside kill', () => {
    expect(apbExitFailure({ signal: 'SIGTERM', code: null, elapsedMs: APB_CLI_TIMEOUT_MS, stderr: '' })).toBe('apb was killed by SIGTERM');
  });
});
