/**
 * Module-size gate. Walks a source directory recursively and fails when a
 * non-test `.ts` file exceeds `HARD_LIMIT` lines; a file past `WARN_LIMIT` is
 * printed on every run and fails nothing, so a module is split while that is
 * still cheap.
 *
 * Usage: `bun run scripts/size-check.ts [src-dir]` (a step of `check.sh`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The smell: a module past this stops fitting in one mental page. */
export const WARN_LIMIT = 400;
/** The limit: a module past this fails the gate and is split. */
export const HARD_LIMIT = 700;

export type SizeEntry = { readonly file: string; readonly lines: number };

export type SizeReport = {
  readonly violations: SizeEntry[];
  /** Over `WARN_LIMIT` but within `HARD_LIMIT`: printed, never fatal. */
  readonly warnings: SizeEntry[];
};

/** Lines of a text, not counting the empty element after a final newline. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function collectModules(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      collectModules(path, root, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(relative(root, path));
  }
}

/** Measures every non-test `.ts` file under `dir`. */
export function checkSizes(dir: string): SizeReport {
  const files: string[] = [];
  collectModules(dir, dir, files);
  const violations: SizeEntry[] = [];
  const warnings: SizeEntry[] = [];
  for (const file of files.toSorted()) {
    const lines = countLines(readFileSync(join(dir, file), 'utf8'));
    if (lines > HARD_LIMIT) violations.push({ file, lines });
    else if (lines > WARN_LIMIT) warnings.push({ file, lines });
  }
  return { violations, warnings };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'src';
  const report = checkSizes(dir);
  for (const entry of report.warnings) console.warn(`  over ${WARN_LIMIT} lines: ${entry.file}  ${entry.lines} lines`);
  if (report.violations.length > 0) {
    console.error(`Size check FAILED (limit ${HARD_LIMIT} lines):`);
    for (const entry of report.violations) console.error(`  ${entry.file}  ${entry.lines} lines`);
    process.exit(1);
  }
  console.log(`Size check OK: ${report.warnings.length} over ${WARN_LIMIT} lines, 0 over ${HARD_LIMIT} in ${dir}`);
}
