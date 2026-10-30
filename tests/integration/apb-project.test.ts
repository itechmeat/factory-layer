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

test('the project APB configuration disables the host fallback', async () => {
  const raw: unknown = Bun.YAML.parse(await Bun.file(join(REPO_ROOT, '.apb', 'config.yaml')).text());
  expect(ApbConfigSchema.parse(raw).execution.fallback_to_host).toBe(false);
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
