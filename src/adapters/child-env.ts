/**
 * The environment of every child process the factory starts for generated
 * code (installs, builds, tests, acceptance checks, the HTTP server) and for
 * git. Invariant: a child sees an explicit allowlist, never the factory's
 * own environment, so no provider key or other secret of the operator
 * reaches a process that runs model-written code. Generated code gets a
 * scratch HOME that lives for one batch and is removed afterwards.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A child process environment: names to values, nothing inherited. */
export type ChildEnv = Readonly<Record<string, string>>;

/** The variables of the factory's environment named in `names` that are set. */
function pick(names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/** A UTF-8 locale every release of the platform ships: older macOS has no `C.UTF-8`, a minimal Linux no `en_US.UTF-8`. */
export function fallbackLang(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

/**
 * The environment of a generated-code process: PATH and LANG from the
 * factory (LANG falls back to a UTF-8 locale of the platform), the scratch
 * `home`, `CI=1` (no watch modes, no prompts) and the caller's `extra`
 * variables (a PORT, a PATH with the package's commands).
 */
export function generatedCodeEnv(home: string, extra: ChildEnv = {}): ChildEnv {
  return { LANG: fallbackLang(process.platform), ...pick(['PATH', 'LANG']), HOME: home, CI: '1', ...extra };
}

/** The environment of a git command: what git reads for its own configuration, never a key, and no prompts. */
export function gitEnv(): ChildEnv {
  return { ...pick(['PATH', 'LANG', 'HOME', 'XDG_CONFIG_HOME']), GIT_TERMINAL_PROMPT: '0' };
}

/** Runs `body` with a fresh scratch HOME directory and removes it afterwards, whatever `body` did. */
export async function withScratchHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'factory-home-'));
  try {
    return await body(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
