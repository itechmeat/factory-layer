/**
 * The composition root: the one place that picks and builds the adapters
 * for a run. The brain (Mozaik over the configured provider, refusing a
 * Mozaik cloud key), the executor and playbook authoring over one `apb mcp`
 * connection rooted at the factory repository, the OSB run memory on the
 * factory's own vault, the file run store and trace under `runs/`, the git
 * workspace under `work/`, the process check runner (stopped by the run's
 * cutoff), the price file, the system clock and wait, and the process-wide
 * executor slots. The brain gets
 * the run's resolved re-plan budget. The provider keys are the secrets every
 * writer redacts.
 */

import { join } from 'node:path';

import { createMozaikBrain } from '../adapters/brain-mozaik/mozaik-brain';
import { parseBrainConfig, type BrainConfig } from '../adapters/brain-mozaik/config';
import { ProcessCheckRunner } from '../adapters/check-runner/check-runner';
import { loadPriceFile, PRICE_FILE } from '../adapters/cost-table/price-file';
import { SharedSlots } from '../adapters/execution-slots/shared-slots';
import { ApbAuthoring } from '../adapters/hands-apb/apb-authoring';
import { apbMcpCommand } from '../adapters/hands-apb/apb-command';
import { ApbExecutor } from '../adapters/hands-apb/apb-executor';
import { systemClock, systemSleep } from '../adapters/index';
import type { FactoryPorts } from '../application/index';
import { connectMcpStdio } from '../adapters/mcp-stdio/client';
import { OsbMemory } from '../adapters/memory-osb/osb-memory';
import { FileRunStore } from '../adapters/trace-fs/store';
import { GitWorkspace } from '../adapters/workspace-git/git-workspace';
import { GIT_COMMAND_TIMEOUT_MS, GLOBAL_EXECUTOR_RUNS } from '../domain/limits';
import { PrintingTraceSink } from './trace-lines';

/** The environment the root reads; `process.env` in production. */
export type Env = Readonly<Record<string, string | undefined>>;

/** A setup problem before the run starts, with what to do about it. */
export class SetupError extends Error {
  constructor(problem: string) {
    super(`${problem}; run \`factory doctor\` for details`);
    this.name = 'SetupError';
  }
}

/** The provider keys of a brain configuration: what every writer redacts. */
export function secretsOf(config: BrainConfig): readonly string[] {
  return config.providers.map((provider) => provider.apiKey);
}

/** Every variable whose value is a key: the brain providers and Mozaik Cloud. */
const KEY_VARIABLES = ['ZAI_API_KEY', 'FALLBACK_API_KEY', 'JIGJOY_ANTHROPIC_API_KEY', 'MOZAIK_API_KEY', 'MOZAIK_PROJECT_KEY'] as const;

/** The key values set in `env`: what a writer redacts even without a valid brain configuration. */
export function envSecrets(env: Env): readonly string[] {
  return KEY_VARIABLES.map((name) => env[name]?.trim() ?? '').filter((value) => value.length > 0);
}

/** The wired factory and how to release it. */
export interface Composition {
  readonly ports: FactoryPorts;
  readonly secrets: readonly string[];
  close(): Promise<void>;
}

/** What the run itself tells the composition: its resolved limits and its cutoff, which the adapters need. */
export interface RunWiring {
  /** The run's resolved re-plan budget; the brain tells recovery when none is left. */
  readonly replanBudget: number;
  /** The run's cutoff: when it fires, the check runner kills the commands it is running. */
  readonly cutoff?: AbortSignal | undefined;
}

/** Builds every adapter for a run rooted at `root`; throws `SetupError` or the adapter's own configuration error. */
export function compose(root: string, env: Env, write: (line: string) => void, wiring: RunWiring): Composition {
  const apb = Bun.which('apb');
  if (apb === null) throw new SetupError('`apb` is not on the PATH');
  const config = parseBrainConfig(env);
  const secrets = [...new Set([...secretsOf(config), ...envSecrets(env)])];
  const costs = loadPriceFile(join(root, PRICE_FILE));
  const executor = new ApbExecutor(() => connectMcpStdio(apbMcpCommand(apb, root, env)));
  const store = new FileRunStore(root, systemClock);
  store.setSecrets(secrets);
  const checks = new ProcessCheckRunner({ signal: wiring.cutoff });
  checks.setSecrets(secrets);
  const ports: FactoryPorts = {
    brain: createMozaikBrain(config, systemClock, costs, { replanBudget: wiring.replanBudget, secrets }),
    executor,
    playbooks: new ApbAuthoring(() => executor.connection()),
    memory: new OsbMemory({ env }),
    store,
    sink: new PrintingTraceSink(root, write, secrets),
    workspace: new GitWorkspace({ workRoot: root, timeoutMs: GIT_COMMAND_TIMEOUT_MS }),
    checks,
    costs,
    clock: systemClock,
    sleep: systemSleep,
    slots: new SharedSlots(GLOBAL_EXECUTOR_RUNS),
  };
  return { ports, secrets, close: () => executor.close() };
}
