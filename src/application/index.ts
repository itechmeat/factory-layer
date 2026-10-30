/**
 * Application layer: the factory state machine and its use cases. It talks to
 * the outside only through ports and may import ports and the domain, never
 * an adapter or the CLI.
 *
 * It exports the RunFactory use case (one spec to an outcome) and the
 * ports it is composed from.
 */

export { RunFactory, type RunRequest, type RunResult } from './run-factory';
export type { FactoryPorts } from './run-context';
