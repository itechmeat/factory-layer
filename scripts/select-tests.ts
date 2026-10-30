/**
 * The `fast` tier's view of "what changed": which tests to run, and which git
 * ref that is measured against.
 *
 * Selection is "the changed files PLUS everything that imports them", never the
 * changed files alone: a fast tier that ran only the test next to the edited
 * module would stay green while that module's callers broke. The import graph is
 * built from the repository's own `import` / `export ... from` / `import()`
 * relative specifiers, and walked BACKWARDS from every changed file.
 *
 * It FAILS rather than under-selects. Every way this tool could answer "nothing
 * changed" when it simply could not see is a loud error instead: a git command that fails, a base ref that does not
 * resolve, a root that is not there, a directory it cannot read. The two cases it cannot answer honestly ; a DELETED module,
 * whose importers have no edge to follow because the node is gone, and a changed
 * manifest, lockfile or runner config, which rewires the very edges this graph
 * is built from or changes how every test runs ; are answered with every test
 * under the roots and a line saying why.
 *
 * This file is the ONE place that parses git output and the ONE place that
 * decides the base, so every consumer measures the same change
 * (`--print-base`, `--print-changed`).
 *
 * What it still cannot see, and what `standard` is for: a fixture read at run
 * time, a global side effect, and an import resolved through a bare specifier
 * or a `tsconfig` path. `fast` serves the TDD loop; it does not
 * replace the proof.
 *
 * POSIX only, by the same decision as the rest of the gate (`mktemp`, `lsof`,
 * `bash`): paths are compared with `/`, and no Windows separator handling is
 * attempted or wanted here.
 *
 * Usage:
 *   `bun run scripts/select-tests.ts [--seed <path>]... <root> [<root> ...]`
 *   `bun run scripts/select-tests.ts --print-base`
 *   `bun run scripts/select-tests.ts --print-changed`
 *
 *   FACTORY_FAST_BASE: the git ref the change is measured against. Default:
 *   the merge base with `main`, so a branch selects against everything it
 *   added, not only against its last commit. In a repository with no commit
 *   yet the base is the empty tree, so every file counts as changed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** File extensions this repository writes modules in. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

/** A test file, by the colocated-`*.test.ts` convention both runners use. */
export const TEST_PATTERN = /\.test\.(?:ts|tsx|mts|cts)$/;

/**
 * Any module specifier: `import ... from 'x'`, `export ... from 'x'`, `import('x')`
 * and the side-effect form `import 'x'`.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** How TypeScript spells a module's own extension in a NodeNext specifier. */
const SPECIFIER_EXTENSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.js$/, '.ts'],
  [/\.mjs$/, '.mts'],
  [/\.cjs$/, '.cts'],
];

/** Files that rewire the graph itself, or every test run, rather than living inside it. */
const REWIRING_PATTERN = /(?:^|\/)(?:package\.json|bun\.lockb?|tsconfig(?:\.[\w-]+)?\.json|bunfig\.toml|fast-bunfig\.toml)$/;

/** Git's well-known empty tree: the base of a repository with no commit yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A git call that failed; `main` turns it into one line and a non-zero exit. */
export class GitError extends Error {}

/**
 * Runs git and returns its stdout, or throws.
 *
 * `maxBuffer` is raised because `diff --name-only` on a long branch can pass
 * Node's 1 MiB default, and truncation here would look exactly like "no
 * changes" ; the failure mode this whole file is written to avoid.
 */
function git(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new GitError(`git ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new GitError(`git ${args.join(' ')} exited ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout ?? '';
}

/**
 * The ref the working tree is compared against.
 *
 * A missing merge base with `main` ; a renamed default branch, a shallow clone,
 * a detached HEAD ; is not silently degraded to "uncommitted work only": the
 * fallback happens, and it says so on stderr. A base handed in through the
 * environment that does not resolve in THIS clone (a stale export from another
 * worktree) is an error, not a quiet degradation.
 */
export function baseRef(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = environment['FACTORY_FAST_BASE'];
  if (explicit !== undefined && explicit !== '') {
    const check = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${explicit}^{tree}`], { encoding: 'utf8' });
    if (check.status !== 0) throw new GitError(`FACTORY_FAST_BASE=${explicit} does not resolve to a tree in this repository`);
    return explicit;
  }
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) return EMPTY_TREE;
  const result = spawnSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' });
  const mergeBase = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (mergeBase !== '') return mergeBase;
  console.error(
    'select-tests: no merge base with `main` (renamed default branch, shallow clone or detached HEAD); ' +
      'measuring against HEAD, so only UNCOMMITTED work is selected; name the base with FACTORY_FAST_BASE',
  );
  return 'HEAD';
}

/**
 * Repository-relative paths of every file the change touches, committed or not.
 *
 * Both git calls use `-z`: NUL-separated paths are never quoted or escaped, so
 * a path with a space or a non-ASCII character matches as written.
 * `--no-renames` because `--name-only` otherwise reports only the DESTINATION of
 * a committed rename, and the source path ; a module its surviving importers
 * may still name ; would never be selected. An uncommitted rename or copy comes
 * from `status` as the destination followed by its source in the next field,
 * and both sides are kept for the same reason.
 */
export function changedPaths(base: string): string[] {
  const paths = new Set<string>();
  for (const path of git(['diff', '--no-renames', '--name-only', '-z', base, '--']).split('\0')) {
    if (path !== '') paths.add(path);
  }
  const fields = git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === '') continue;
    paths.add(field.slice(3));
    const status = field.slice(0, 2);
    if (status.includes('R') || status.includes('C')) {
      const source = fields[index + 1];
      if (source !== undefined && source !== '') paths.add(source);
      index += 1;
    }
  }
  return [...paths];
}

/**
 * Every module under the given roots, as absolute paths.
 *
 * A root that is not there, or a directory that cannot be read, is an error:
 * this guards against an empty file list, an empty selection and a green tier
 * that ran nothing.
 */
export function sourceFiles(roots: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      throw new Error(`select-tests: cannot read ${dir}`, { cause: error });
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isDirectory()) walk(full);
      else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) files.push(full);
    }
  };
  for (const root of roots) {
    const absolute = resolve(root);
    if (!existsSync(absolute)) throw new Error(`select-tests: root does not exist: ${root}`);
    walk(absolute);
  }
  return files;
}

/** The first of `candidates` that is a file on disk, or `null`. */
function firstFile(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const stat = statSync(candidate, { throwIfNoEntry: false });
    if (stat !== undefined && stat.isFile()) return candidate;
  }
  return null;
}

/** Module candidates for a path with or without its extension. */
function moduleCandidates(base: string): string[] {
  const rewritten = SPECIFIER_EXTENSIONS.reduce((path, [pattern, extension]) => path.replace(pattern, extension), base);
  return [
    base,
    rewritten,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
}

/**
 * Resolves one specifier against the file that wrote it, or `null`.
 *
 * Relative specifiers resolve on disk. A bare specifier (a dependency) stays
 * invisible on purpose: it is not part of this repository's own graph.
 */
export function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return firstFile(moduleCandidates(resolve(dirname(from), specifier)));
  return null;
}

/** importee -> the files that import it, for every module in `files`. */
export function importerGraph(files: readonly string[]): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const target = resolveSpecifier(file, specifier);
      if (target === null) continue;
      const list = importers.get(target);
      if (list === undefined) importers.set(target, [file]);
      else list.push(file);
    }
  }
  return importers;
}

/** The changed files and, transitively, every file that imports one of them. */
export function affected(seeds: readonly string[], importers: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (reached.has(seed)) continue;
    reached.add(seed);
    queue.push(seed);
  }
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const importer of importers.get(current) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached;
}

/** What a change selects, and whether the selector had to give up and take everything. */
export interface Selection {
  /** Absolute test paths to run. */
  readonly tests: string[];
  /** True when `tests` is every test under the roots. */
  readonly everything: boolean;
  /** Why it is everything, in one phrase, or `null`. */
  readonly reason: string | null;
}

/** Does this path look like a module this repository would have tested? */
function isModulePath(path: string, roots: readonly string[]): boolean {
  if (!EXTENSIONS.some((extension) => path.endsWith(extension))) return false;
  return roots.some((root) => path.startsWith(`${resolve(root)}/`));
}

/**
 * The test files a change to `seeds` can reach, given the modules under `roots`.
 *
 * Two cases the backward walk cannot answer, both handled by taking everything
 * and saying so rather than returning a confident empty list:
 *
 *   - a DELETED module: its node is gone, so none of its importers is reachable,
 *     and the most common breaking refactor would select nothing at all;
 *   - a changed manifest, lockfile or runner config: the first two are the
 *     inputs this graph is built from, so a change to one can invalidate every
 *     edge in it, and the runner config (`bunfig.toml`) changes how every test
 *     runs.
 */
export function selectTests(roots: readonly string[], seeds: readonly string[], repoRoot?: string): Selection {
  const files = sourceFiles(roots);
  const known = new Set(files);
  const everyTest = files.filter((file) => TEST_PATTERN.test(file)).toSorted();
  const root = repoRoot ?? process.cwd();

  const rewiring = seeds.filter((seed) => REWIRING_PATTERN.test(seed)).toSorted();
  if (rewiring.length > 0) {
    const names = rewiring.map((path) => relative(root, path)).join(', ');
    return {
      tests: everyTest,
      everything: true,
      reason: `a manifest, lockfile or runner config changed (${names}); every import edge or test run depends on those`,
    };
  }

  const deleted = seeds.filter((seed) => !known.has(seed) && isModulePath(seed, roots)).toSorted();
  if (deleted.length > 0) {
    const names = deleted.map((path) => relative(root, path)).join(', ');
    return {
      tests: everyTest,
      everything: true,
      reason: `module(s) deleted or renamed away (${names}); their importers have no edge left to follow`,
    };
  }

  const present = seeds.filter((seed) => known.has(seed));
  const reached = affected(present, importerGraph(files));
  return { tests: [...reached].filter((file) => TEST_PATTERN.test(file)).toSorted(), everything: false, reason: null };
}

/** `--flag` arguments, in the order they appeared, plus everything else. */
function partition(argv: readonly string[]): { flags: string[]; seeds: string[]; rest: string[] } {
  const flags: string[] = [];
  const seeds: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--seed') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('select-tests: --seed needs a path');
      seeds.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) flags.push(argument);
    else rest.push(argument);
  }
  return { flags, seeds, rest };
}

function main(): void {
  const { flags, seeds: extraSeeds, rest: roots } = partition(process.argv.slice(2));
  const repoRoot = git(['rev-parse', '--show-toplevel']).trim();

  if (flags.includes('--print-base')) {
    console.log(baseRef());
    return;
  }
  if (flags.includes('--print-changed')) {
    for (const path of changedPaths(baseRef()).toSorted()) console.log(path);
    return;
  }
  if (roots.length === 0) {
    console.error('usage: bun run scripts/select-tests.ts [--seed <path>]... <root> [<root> ...]');
    process.exit(2);
  }
  const seeds = [...changedPaths(baseRef()), ...extraSeeds].map((path) => resolve(repoRoot, path));
  const selection = selectTests(roots, seeds, repoRoot);
  if (selection.reason !== null) console.error(`select-tests: ${selection.reason}; every test under the roots is selected`);
  for (const test of selection.tests) console.log(relative(repoRoot, test));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`select-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
