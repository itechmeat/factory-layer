/**
 * The checks `factory doctor` runs before a run: the brain configuration and
 * one tiny decision (naming the provider and model that answered), Mozaik
 * Cloud off, on (a key with the opt-in) or refused (a key without it), `apb` on the PATH with its version
 * and an MCP handshake (each with its own budget), the starter playbooks
 * approved at their current versions and their default profile at its
 * current bundle (see `doctor-apb.ts`), Claude Code installed and logged in
 * (the default agent profile), the factory's OSB vault configured and
 * answering a handshake, and `git`, `bun` and `npm` on the PATH. Every MCP
 * check runs under its abort signal, so a check past its deadline closes
 * its client and the server process ends. Every answer read from a tool is
 * validated with Zod; no secret value is ever printed.
 */

import { homedir } from 'node:os';

import { z } from 'zod';

import { cloudRedaction, mozaikCloudState, MozaikCloudKeyError } from '../adapters/brain-mozaik/cloud-guard';
import { parseBrainConfig } from '../adapters/brain-mozaik/config';
import { createMozaikDecider } from '../adapters/brain-mozaik/decider';
import { apbMcpCommand } from '../adapters/hands-apb/apb-command';
import { STARTER_PARAMS } from '../adapters/hands-apb/start-inputs';
import { systemClock } from '../adapters/index';
import type { McpServerCommand } from '../adapters/mcp-stdio/client';
import type { Env } from './compose';
import type { DoctorCheck } from './doctor';
import { starterApproval, withServer } from './doctor-apb';

const SPAWN_CHECK_MS = 15_000;
/** `apb --version`, then the `apb mcp` handshake and one tool listing, each with its own budget. */
const APB_VERSION_MS = 10_000;
const MCP_CONNECT_MS = 20_000;
const MCP_CALL_MS = 10_000;
/** A whole MCP check: the handshake, its calls and room for the close. */
const MCP_CHECK_MS = MCP_CONNECT_MS + 3 * MCP_CALL_MS;
const BRAIN_CHECK_MS = 45_000;

/** Runs `command` and returns its trimmed stdout; rejects on a non-zero exit or a missing binary. */
async function output(command: readonly string[], signal: AbortSignal): Promise<string> {
  const [file, ...args] = command;
  const path = file === undefined ? null : Bun.which(file);
  if (path === null) throw new Error(`${file ?? 'command'} is not on the PATH`);
  const child = Bun.spawn([path, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', signal });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${String(code)}`);
  return stdout.trim();
}

/** The budget of one MCP check under `signal`. */
function budget(signal: AbortSignal): { signal: AbortSignal; connectMs: number; callMs: number } {
  return { signal, connectMs: MCP_CONNECT_MS, callMs: MCP_CALL_MS };
}

function apbServer(root: string, env: Env): McpServerCommand {
  const apb = Bun.which('apb');
  if (apb === null) throw new Error('apb is not on the PATH');
  return apbMcpCommand(apb, root, env);
}

const ClaudeAuthSchema = z.looseObject({ loggedIn: z.boolean() });
const Ping = z.object({ ok: z.boolean() });

function tool(name: string, fix: string): DoctorCheck {
  return { name, deadlineMs: SPAWN_CHECK_MS, fix, run: (signal) => output([name, '--version'], signal) };
}

/** Every doctor check for the factory rooted at `root`. */
export function doctorChecks(root: string, env: Env): readonly DoctorCheck[] {
  return [
    {
      name: 'brain',
      deadlineMs: BRAIN_CHECK_MS,
      fix: 'set ZAI_API_KEY (and ZAI_BASE_URL, ZAI_MODEL when not the defaults), and for the gateway FACTORY_BRAIN_GATEWAY=1 with both JIGJOY_ANTHROPIC_* variables, in .env; see .env.example',
      run: async (signal) => {
        const config = parseBrainConfig(env);
        const decider = createMozaikDecider(config, systemClock, { env, cwd: process.cwd(), home: homedir() });
        const started = performance.now();
        const result = await decider.decide({
          role: 'critic',
          system: 'You check that the tools work. Call the submit tool with ok set to true.',
          user: 'Check.',
          schema: Ping,
          deadlineMs: BRAIN_CHECK_MS - 5000,
          signal,
        });
        const answered = result.usage.findLast((call) => call.failure === undefined);
        const who = answered === undefined ? 'the brain' : `${answered.provider}/${answered.reportedModel ?? answered.model}`;
        const order = config.providers.map((provider) => `${provider.name}/${provider.model}`).join(', ');
        return `${who} answered through the submit tool in ${String(Math.round(performance.now() - started))} ms (providers: ${order})`;
      },
    },
    {
      name: 'mozaik cloud',
      deadlineMs: SPAWN_CHECK_MS,
      fix: 'remove MOZAIK_API_KEY and MOZAIK_PROJECT_KEY from the environment and .env and the Mozaik credentials file, or set FACTORY_MOZAIK_CLOUD=1 to send loop events to Mozaik Cloud',
      run: async () => {
        const cloud = mozaikCloudState({ env, cwd: process.cwd(), home: homedir() });
        if (cloud.state === 'refused') throw new MozaikCloudKeyError(cloud.found);
        if (cloud.state === 'off') return 'off';
        return `on (key present: ${cloud.found}; redaction ${cloudRedaction({ ...env })})`;
      },
    },
    {
      name: 'apb',
      deadlineMs: APB_VERSION_MS + MCP_CHECK_MS,
      fix: 'install apb and put it on the PATH',
      run: async (signal) => {
        const version = await output(['apb', '--version'], AbortSignal.any([signal, AbortSignal.timeout(APB_VERSION_MS)]));
        const tools = await withServer(apbServer(root, env), budget(signal), (client) => client.listTools());
        return `${version}; apb mcp answered with ${String(tools.length)} tools`;
      },
    },
    {
      name: 'starter playbooks',
      deadlineMs: MCP_CHECK_MS,
      fix: 'run `bun run apb:bootstrap` to approve the current versions and profile bundles',
      run: (signal) =>
        withServer(apbServer(root, env), budget(signal), (client) => starterApproval(client, Object.keys(STARTER_PARAMS), MCP_CALL_MS)),
    },
    {
      name: 'claude code',
      deadlineMs: SPAWN_CHECK_MS,
      fix: 'install Claude Code and log in with `claude`',
      run: async (signal) => {
        const status = ClaudeAuthSchema.parse(JSON.parse(await output(['claude', 'auth', 'status'], signal)));
        if (!status.loggedIn) throw new Error('Claude Code is not logged in');
        return 'logged in';
      },
    },
    {
      name: 'osb vault',
      deadlineMs: MCP_CHECK_MS,
      fix: "set FACTORY_OSB_VAULT and FACTORY_OSB_CONFIG in .env to the factory's own vault, and put o2b on the PATH",
      run: async (signal) => {
        const config = env['FACTORY_OSB_CONFIG'];
        const vault = env['FACTORY_OSB_VAULT'];
        if (!config || !vault) throw new Error('FACTORY_OSB_CONFIG and FACTORY_OSB_VAULT must both be set');
        const o2b = Bun.which('o2b');
        if (o2b === null) throw new Error('o2b is not on the PATH');
        const server: McpServerCommand = { command: o2b, args: ['mcp', '--config', config, '--vault', vault] };
        const tools = await withServer(server, budget(signal), (client) => client.listTools());
        return `o2b mcp answered with ${String(tools.length)} tools`;
      },
    },
    tool('git', 'install git'),
    tool('bun', 'install bun'),
    tool('npm', 'install Node.js with npm'),
  ];
}
