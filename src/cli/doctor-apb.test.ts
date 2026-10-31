/**
 * The doctor's APB trust check over recorded answers: the starters approved
 * at their current versions and their default profile's current bundle
 * approved pass; a starter whose current version is not approved, or a
 * profile whose current bundle is not, fails naming it. An aborted server
 * check closes its client and the server process is gone.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';

import { isProcessAlive } from '../adapters/mcp-stdio/process-teardown';
import { answerOf } from '../adapters/hands-apb/testing/apb-fixtures';
import { FakeApb, type FakeHandler } from '../adapters/hands-apb/testing/fake-apb';
import { starterApproval, withServer } from './doctor-apb';

const STARTERS = ['build-task', 'integrate'];
const CatalogEntriesSchema = z.array(z.looseObject({ ref: z.looseObject({ id: z.string() }), trusted: z.boolean() }));
const FIXTURE = join(import.meta.dir, '../../tests/fixtures/fake-mcp-server.ts');

function apbWith(overrides: Record<string, FakeHandler> = {}): FakeApb {
  return new FakeApb({
    playbook_catalog: async () => answerOf('playbook_catalog'),
    playbook_get: async (args) => ({ id: args['id'], defaults: { profile: { name: 'claude', scope: 'auto' } } }),
    profile_get: async () => answerOf('profile_get-claude'),
    trust_list: async () => answerOf('trust_list'),
    ...overrides,
  });
}

describe('starter approval', () => {
  test('starters approved at their current versions and an approved default profile bundle pass, naming the versions', async () => {
    const found = await starterApproval(apbWith(), STARTERS, 1000);
    expect(found).toContain('build-task 1.0.0');
    expect(found).toContain('integrate 2.0.0');
    expect(found).toContain('profile claude');
  });

  test('a starter whose current version is not approved fails, naming it and its version', async () => {
    const catalog = answerOf('playbook_catalog');
    const entries = CatalogEntriesSchema.parse(catalog['entries']).map((entry) =>
      entry.ref.id === 'build-task' ? { ...entry, trusted: false } : entry,
    );
    catalog['entries'] = entries;
    await expect(starterApproval(apbWith({ playbook_catalog: async () => catalog }), STARTERS, 1000)).rejects.toThrow(
      'build-task 1.0.0 is not approved at its current version',
    );
  });

  test('a starter missing from the catalog fails', async () => {
    await expect(starterApproval(apbWith(), [...STARTERS, 'absent'], 1000)).rejects.toThrow('absent is not in the playbook catalog');
  });

  test('a default profile whose current bundle is not approved fails, naming the profile', async () => {
    const changed = { ...answerOf('profile_get-claude'), bundle_digest: 'sha256:0000' };
    await expect(starterApproval(apbWith({ profile_get: async () => changed }), STARTERS, 1000)).rejects.toThrow(
      'profile claude: its current bundle is not approved',
    );
  });
});

describe('withServer', () => {
  test('an abort during the work closes the client and the server process is gone', async () => {
    const controller = new AbortController();
    let pid = 0;
    const work = withServer(
      { command: process.execPath, args: [FIXTURE] },
      { signal: controller.signal, connectMs: 5000, callMs: 10_000 },
      async (client) => {
        pid = client.pid;
        setTimeout(() => controller.abort(), 50);
        return client.callTool('slow', {});
      },
    );
    await expect(work).rejects.toThrow();
    expect(isProcessAlive(pid)).toBe(false);
  });
});
