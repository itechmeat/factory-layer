import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { REPO_ROOT } from './support/apb';
import { requireBinary } from './support/prerequisites';

/** Budget for `apb validate` on the project, in milliseconds. */
const VALIDATE_TIMEOUT_MS = 60_000;

/** Slack on top of the validate budget for spawning and the assertions, in milliseconds. */
const TEST_SLACK_MS = 10_000;

const ApbConfigSchema = z.object({ execution: z.object({ fallback_to_host: z.boolean() }) });

/** One project profile per supported agent CLI, named after it. */
const AGENT_PROFILES = ['agy', 'claude', 'codex', 'grok', 'opencode', 'zcode'];

/** The coding playbooks the factory dispatches. */
const STARTERS = ['scaffold', 'implement-task', 'repair', 'integrate'];

const ProfileSchema = z.object({ name: z.string(), executor: z.object({ agent: z.string(), fallbacks: z.array(z.unknown()) }) });

const PlaybookDefaultsSchema = z.object({ defaults: z.object({ profile: z.object({ name: z.string() }) }) });

async function yamlOf(...path: string[]): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(join(REPO_ROOT, '.apb', ...path)).text());
}

test('the project APB configuration disables the host fallback', async () => {
  const raw: unknown = Bun.YAML.parse(await Bun.file(join(REPO_ROOT, '.apb', 'config.yaml')).text());
  expect(ApbConfigSchema.parse(raw).execution.fallback_to_host).toBe(false);
});

test('the project ships one profile per agent CLI, named after it and without a fallback', async () => {
  expect(readdirSync(join(REPO_ROOT, '.apb', 'profiles')).toSorted()).toEqual(AGENT_PROFILES);
  for (const name of AGENT_PROFILES) {
    const profile = ProfileSchema.parse(await yamlOf('profiles', name, 'profile.yaml'));
    expect({ name: profile.name, agent: profile.executor.agent, fallbacks: profile.executor.fallbacks }).toEqual({
      name,
      agent: name,
      fallbacks: [],
    });
  }
});

test('the current version of every starter playbook defaults to the claude profile', async () => {
  for (const id of STARTERS) {
    const version = (await Bun.file(join(REPO_ROOT, '.apb', 'playbooks', id, 'current')).text()).trim();
    const playbook = PlaybookDefaultsSchema.parse(await yamlOf('playbooks', id, version, 'playbook.yaml'));
    expect({ id, profile: playbook.defaults.profile.name }).toEqual({ id, profile: 'claude' });
  }
});

test(
  'apb validate reports every project playbook OK and exits 0',
  async () => {
    const playbooks = readdirSync(join(REPO_ROOT, '.apb', 'playbooks'));
    const child = Bun.spawn([requireBinary('apb'), 'validate'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: VALIDATE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    const lines = stdout.trim().split('\n').toSorted();
    expect(lines).toEqual(playbooks.map((playbook) => `${playbook}: OK`).toSorted());
  },
  VALIDATE_TIMEOUT_MS + TEST_SLACK_MS,
);
