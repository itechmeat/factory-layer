/**
 * Module-header gate. Every non-test `.ts` module must open with a JSDoc
 * block (`/**`) that states its responsibility; a test file is exempt, its
 * `describe` names say what it covers.
 *
 * Usage: `bun run scripts/header-check.ts <dir> [<dir> ...]` (a step of
 * `check.sh`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** True when the module's first non-blank text opens a JSDoc block. */
export function hasHeader(source: string): boolean {
  const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
  return body.trimStart().startsWith('/**');
}

function collectModules(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collectModules(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
}

/** Every non-test module under `dirs` that lacks a header, sorted. */
export function missingHeaders(dirs: readonly string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) collectModules(dir, files);
  return files.filter((file) => !hasHeader(readFileSync(file, 'utf8'))).toSorted();
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  const missing = missingHeaders(dirs.length > 0 ? dirs : ['src']);
  if (missing.length > 0) {
    console.error('Header check FAILED: these modules do not open with a /** responsibility header */:');
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log('Header check OK: every module opens with a JSDoc header');
}
