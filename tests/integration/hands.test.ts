import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { apbMcpCommand } from '../../src/adapters/hands-apb/apb-command';
import { FOLLOW_RUN_CLEANUP_BUDGET_MS, followRun, type FollowRunOutcome } from '../../src/adapters/hands-apb/follow-run';
import type { StartRecovery } from '../../src/adapters/hands-apb/recover-start';
import { connectMcpStdio } from '../../src/adapters/mcp-stdio/client';
import { isProcessAlive } from '../../src/adapters/mcp-stdio/process-teardown';
import { REPO_ROOT } from './support/apb';
import { requireBinary } from './support/prerequisites';

/** Run limit of the `smoke` playbook, in milliseconds. */
const SMOKE_RUN_LIMIT_MS = 300_000;

/** Run limit of the never-finishing `smoke-stall` playbook, in milliseconds. */
const STALL_RUN_LIMIT_MS = 20_000;

/** Slack on top of the run limit and the cleanup budget, in milliseconds. */
const TEST_SLACK_MS = 30_000;

const TRUST_HINT = 'approve the profiles and the smoke playbooks first (README, APB trust bootstrap)';

/** Why a smoke run did not start, with the hint that fits what is known. */
function startFailure(playbookId: string, detail: string, recovery: StartRecovery): string {
  switch (recovery.kind) {
    case 'not_started': {
      return `${playbookId} did not start: ${detail}; ${TRUST_HINT}`;
    }
    case 'unknown': {
      return `${playbookId}: the start answer was lost and the runs could not be searched (${recovery.detail}); a detached run may still be alive, check \`apb runs\` and stop it with \`apb stop <run_id>\``;
    }
    case 'not_found': {
      return `${playbookId}: the start answer was lost (${detail}) and no run of it was found`;
    }
    case 'stopped':
    case 'cleanup_timeout': {
      return `${playbookId}: the start answer was lost (${detail}); run ${recovery.runId} was found, recovery ${recovery.kind}`;
    }
  }
}

/**
 * Starts `apb mcp`, follows one supervised run in a worktree of its own
 * (under the git-ignored `work/`), and always stops the server and removes
 * the worktree. The unique worktree identifies the run if its start answer
 * is lost.
 */
async function followPlaybook(playbookId: string, runLimitMs: number): Promise<FollowRunOutcome> {
  const worktree = join(REPO_ROOT, 'work', `smoke-${playbookId}-${randomUUID()}`);
  mkdirSync(worktree, { recursive: true });
  let outcome: FollowRunOutcome;
  try {
    const client = await connectMcpStdio(apbMcpCommand(requireBinary('apb'), REPO_ROOT));
    try {
      outcome = await followRun(client, { playbookId, worktree, runLimitMs });
    } finally {
      await client.close();
    }
    expect(isProcessAlive(client.pid)).toBe(false);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
  if (outcome.kind === 'start_failed') {
    throw new Error(startFailure(playbookId, outcome.detail, outcome.recovery));
  }
  return outcome;
}

test(
  'APB smoke: a supervised run of smoke succeeds within its limit and no apb mcp remains',
  async () => {
    const outcome = await followPlaybook('smoke', SMOKE_RUN_LIMIT_MS);
    expect(outcome).toMatchObject({ kind: 'succeeded' });
    expect(outcome.elapsedMs).toBeLessThan(SMOKE_RUN_LIMIT_MS);
  },
  SMOKE_RUN_LIMIT_MS + FOLLOW_RUN_CLEANUP_BUDGET_MS + TEST_SLACK_MS,
);

test(
  'APB stall smoke: smoke-stall is stopped at its limit, ends terminal with its driver gone, and no apb mcp remains',
  async () => {
    const outcome = await followPlaybook('smoke-stall', STALL_RUN_LIMIT_MS);
    // `stopped` is returned only once `run_status` showed a terminal run with no live driver.
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'run_limit', finalStatus: 'aborted' });
    expect(outcome.elapsedMs).toBeLessThan(STALL_RUN_LIMIT_MS + FOLLOW_RUN_CLEANUP_BUDGET_MS);
  },
  STALL_RUN_LIMIT_MS + FOLLOW_RUN_CLEANUP_BUDGET_MS + TEST_SLACK_MS,
);
