/**
 * The guard every package step (an install, a build, a test, a server start)
 * passes before it runs `npm` or `bun` in a directory. Both tools walk up
 * from their working directory to the nearest `package.json`, so a step in
 * a directory without one would install into (and leave a lockfile in) an
 * ancestor such as the factory's own repository. Invariant: a step runs
 * only in a directory that holds its own `package.json`, and every `npm`
 * command is pinned to that directory with `--prefix`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The failure detail of a step whose directory has no `package.json`, or null when it has one. */
export function missingPackageJson(dir: string): string | null {
  return existsSync(join(dir, 'package.json')) ? null : `no package.json in ${dir}`;
}

/** The arguments of an `npm` command pinned to `dir`: `--prefix <dir>` before `args`. */
export function npmArgs(dir: string, args: readonly string[]): string[] {
  return ['--prefix', dir, ...args];
}
