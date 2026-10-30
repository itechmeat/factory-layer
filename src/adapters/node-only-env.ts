/**
 * The Node-only environment of generated code: the allowlisted
 * generated-code environment with `PATH` set to one tool directory, a
 * temporary directory of symlinks to `node`, `npm`, `npx`, `git`, the
 * shells and the core utilities a package script calls, each resolved from
 * a given `PATH`. Removing whole directories from `PATH` is not enough,
 * because Homebrew and other layouts put `bun`, `node` and `npm` in one
 * directory. Invariant: the tool directory never holds `bun` or `bunx`,
 * nor any tool that resolves to a file named `bun` or `bunx` (a `node`
 * shim that is Bun in disguise is skipped for the next one on the `PATH`),
 * so a package that only works under Bun fails here as it would on a
 * Node-only grader. A tool not found is left out. Each tool directory is
 * built once per `PATH` per process and removed when the process exits.
 */

import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import { generatedCodeEnv, type ChildEnv } from './child-env';

/** The tools linked into a Node-only tool directory: Node, git, shells and the core utilities scripts call. */
export const NODE_ONLY_TOOLS = [
  'node',
  'npm',
  'npx',
  'git',
  'sh',
  'bash',
  'env',
  'awk',
  'basename',
  'cat',
  'chmod',
  'cp',
  'cut',
  'date',
  'diff',
  'dirname',
  'echo',
  'false',
  'find',
  'grep',
  'head',
  'ln',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'printf',
  'pwd',
  'rm',
  'sed',
  'sleep',
  'sort',
  'tail',
  'tee',
  'test',
  'touch',
  'tr',
  'true',
  'uname',
  'uniq',
  'wc',
  'which',
  'xargs',
] as const;

/** File names that are Bun, under whatever name they are linked. */
const BUN_FILES = new Set(['bun', 'bunx']);

/** The tool directory built for each PATH value in this process. */
const built = new Map<string, string>();

/** Removes every tool directory this process built. */
function removeToolDirs(): void {
  for (const dir of built.values()) rmSync(dir, { recursive: true, force: true });
  built.clear();
}

/** The first executable file named `name` in `dirs` that is not Bun, or null. */
function resolveTool(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile() && !BUN_FILES.has(basename(realpathSync(candidate)))) return candidate;
    } catch {
      // Absent or not executable here: the next directory may have it.
    }
  }
  return null;
}

/** Builds (once per `path` value) the tool directory of the tools found on `path`, and returns it. */
export function toolDir(path: string): string {
  const existing = built.get(path);
  if (existing !== undefined) return existing;
  // Only absolute entries: an empty or relative entry would resolve against the package's own directory.
  const dirs = path.split(delimiter).filter((entry) => isAbsolute(entry));
  const dir = mkdtempSync(join(tmpdir(), 'factory-node-only-'));
  for (const name of NODE_ONLY_TOOLS) {
    const target = resolveTool(name, dirs);
    if (target !== null) symlinkSync(target, join(dir, name));
  }
  if (built.size === 0) process.once('exit', removeToolDirs);
  built.set(path, dir);
  return dir;
}

/**
 * The environment of a Node-only process: `generatedCodeEnv(home, extra)`
 * with `PATH` replaced by the tool directory of the factory's own `PATH`
 * (an `extra` PATH is replaced too; a caller prepends to the result).
 */
export function nodeOnlyEnv(home: string, extra: ChildEnv = {}): ChildEnv {
  return { ...generatedCodeEnv(home, extra), PATH: toolDir(process.env['PATH'] ?? '') };
}
