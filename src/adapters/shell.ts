/**
 * The shell that runs command checks and spec examples. On macOS the
 * system `/bin/bash` is version 3.2 and often comes first on the `PATH`
 * even when Homebrew's bash 5 is installed, so the shell is resolved once
 * per process: the first executable file among the Homebrew locations
 * (Apple silicon, then Intel), else `bash` from the `PATH`. Every place
 * that runs `bash -c` uses `bashCommand()`, so they all agree.
 */

import { accessSync, constants, statSync } from 'node:fs';

/** Where a newer bash lives on macOS under Homebrew, best first. */
export const BASH_CANDIDATES: readonly string[] = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'];

/** The first executable regular file among `candidates`, else `bash` (resolved through the `PATH` by the spawn). */
export function pickBash(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Absent or not executable: the next candidate may be usable.
    }
  }
  return 'bash';
}

let chosen: string | undefined;

/** The shell of this process, resolved on first use. */
export function bashCommand(): string {
  chosen ??= pickBash(BASH_CANDIDATES);
  return chosen;
}

/** The major version in the first line of `bash --version`, or null when it is not bash output. */
export function bashMajorVersion(versionOutput: string): number | null {
  const match = /version (\d+)\./.exec(versionOutput.split('\n')[0] ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}
