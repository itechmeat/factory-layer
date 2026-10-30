/**
 * The decision-level API of the Mozaik brain: one runtime on the guarded
 * runner, one joined agent per role, and `decide`, which runs one bounded
 * decision attempt as a loop on the role's agent. Decisions of different
 * roles, and of the same role, run as concurrent loops.
 *
 * Construction from configuration refuses to start when a Mozaik cloud key
 * is configured without the `FACTORY_MOZAIK_CLOUD=1` opt-in, and installs the process guard that logs any loop
 * rejection the runner could not attribute.
 */

import { homedir } from 'node:os';

import { createAgent, defineRuntime, RuntimeState } from '@mozaik-ai/core';

import type { Clock } from '../../ports/index';
import { assertMozaikCloudAllowed, cloudRedaction, type CloudGuardScope } from './cloud-guard';
import type { BrainConfig } from './config';
import { BRAIN_ROLES, DECISION_STEP_CAP, type BrainRole, type DecisionRequest, type DecisionResult } from './decision';
import { runDecisionAttempt, type LoopStarter } from './decision-attempt';
import type { BrainError } from './errors';
import { guardUnattributedRejections } from './process-guard';
import { createBrainRunner } from './providers';
import type { GuardedInferenceRunner } from './runner';

/** The runtime state of the brain; Mozaik's base state is all it needs. */
class BrainState extends RuntimeState {}

/** What a decider is built from; `log` receives rejections nobody could attribute. */
export interface MozaikDeciderOptions {
  readonly runner: GuardedInferenceRunner;
  readonly clock: Clock;
  readonly stepCap?: number;
  readonly log?: (message: string) => void;
}

/** Errors already settled on their attempt; the process guard ignores them. */
const attributed = new WeakSet<object>();

function logToConsole(message: string): void {
  console.error(message);
}

/** The brain's decision engine: three role agents on one Mozaik runtime. */
export class MozaikDecider {
  readonly #runner: GuardedInferenceRunner;
  readonly #clock: Clock;
  readonly #stepCap: number;
  readonly #runLoop: LoopStarter;
  readonly #agents: ReadonlyMap<BrainRole, string>;

  constructor(options: MozaikDeciderOptions) {
    this.#runner = options.runner;
    this.#clock = options.clock;
    this.#stepCap = options.stepCap ?? DECISION_STEP_CAP;
    const runtime = defineRuntime<BrainState>();
    runtime.initializeRuntime({ state: new BrainState(), inferenceRunnerConfig: { runner: options.runner } });
    const agents = new Map<BrainRole, string>();
    for (const role of BRAIN_ROLES) {
      const agent = createAgent({ name: role, capabilities: ['decide'], instruction: '', tools: [], handlers: [] });
      runtime.join(agent);
      agents.set(role, agent.getId());
    }
    this.#agents = agents;
    this.#runLoop = runtime.runLoop;
    const log = options.log ?? logToConsole;
    guardUnattributedRejections(process, {
      isAttributed: (reason) => typeof reason === 'object' && reason !== null && attributed.has(reason),
      log: (reason) => log(`brain: a loop rejection no attempt could claim: ${reason instanceof Error ? reason.message : String(reason)}`),
    });
  }

  /** Runs one decision attempt on the role's agent; rejects with `DecisionError` carrying the usage so far. */
  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    const agentId = this.#agents.get(request.role);
    if (agentId === undefined) throw new Error(`No agent for role ${request.role}`);
    return runDecisionAttempt(
      {
        runner: this.#runner,
        runLoop: this.#runLoop,
        agentId,
        clock: this.#clock,
        stepCap: this.#stepCap,
        attributed: (error: BrainError) => attributed.add(error),
      },
      request,
    );
  }
}

/**
 * The decider for a configuration: refuses with `MozaikCloudKeyError` when a
 * Mozaik cloud key is configured without the opt-in, then builds the runner over the configured
 * providers.
 */
export function createMozaikDecider(config: BrainConfig, clock: Clock, scope?: CloudGuardScope): MozaikDecider {
  const cloud = assertMozaikCloudAllowed(scope ?? { env: process.env, cwd: process.cwd(), home: homedir() });
  // The cloud client reads its redaction mode from the process environment at every loop.
  if (cloud.state === 'on') cloudRedaction(process.env);
  return new MozaikDecider({ runner: createBrainRunner(config, clock), clock });
}
