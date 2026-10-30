/**
 * How the factory starts `apb mcp`: in the given project root, in CLI
 * execution mode (agent work only through agent CLIs), with Claude Code's
 * `CLAUDE.md` loading switched off for every agent process APB spawns (the
 * task trees live inside the factory repository, whose own instructions an
 * agent must not see; APB profiles cannot set a variable, only pass the
 * inherited ones), and with the caller's APB configuration location passed
 * through (`APB_CONFIG_DIR`, else `XDG_CONFIG_HOME`; `HOME` is always passed
 * by the stdio client), so a run can use an isolated trust store.
 */

import type { McpServerCommand } from '../mcp-stdio/client';

/** Variables that decide where APB finds its configuration and trust store. */
const APB_LOCATION_VARIABLES = ['APB_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const;

/** Variables every agent process must see, whatever profile runs it. */
const AGENT_ENV = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } as const;

/** The `apb mcp` command for the project at `projectRoot`. */
export function apbMcpCommand(
  apbPath: string,
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpServerCommand {
  const serverEnv: Record<string, string> = { APB_EXECUTION: 'cli', ...AGENT_ENV };
  for (const name of APB_LOCATION_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '') serverEnv[name] = value;
  }
  return { command: apbPath, args: ['mcp'], cwd: projectRoot, env: serverEnv };
}
