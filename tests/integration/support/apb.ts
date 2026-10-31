/**
 * Where the integration smokes find their APB projects: the repository
 * root, which holds the factory's `.apb/`, and the smoke project beside the
 * tests, which holds the script playbooks the executor smokes run. The
 * `apb mcp` command itself comes from `src/adapters/hands-apb/apb-command.ts`.
 */

import { join } from 'node:path';

/** The repository root, where `.apb/` lives. */
export const REPO_ROOT = join(import.meta.dir, '../../..');

/** The APB project of the smoke playbooks; their working trees live under its `work/`. */
export const SMOKE_PROJECT_ROOT = join(import.meta.dir, '..', 'apb-fixture');
