/**
 * CLI layer: the composition root and the `factory` command. It is the only
 * place that picks adapters and wires them into the application.
 *
 * Today it prints the status line; the commands of the design arrive with
 * their OpenSpec changes.
 */

import { systemClock } from '../adapters/index';
import { statusLine } from '../application/index';

/** Runs the CLI with `write` as stdout and returns the process exit code. */
export function main(write: (line: string) => void): number {
  write(statusLine(systemClock));
  return 0;
}

if (import.meta.main) process.exitCode = main(console.log);
