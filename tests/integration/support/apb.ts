/**
 * Where the integration smokes find the factory project: the repository
 * root, which holds `.apb/`. The `apb mcp` command itself comes from
 * `src/adapters/hands-apb/apb-command.ts`.
 */

import { join } from 'node:path';

/** The repository root, where `.apb/` lives. */
export const REPO_ROOT = join(import.meta.dir, '../../..');
