/**
 * The parts of a candidate package's package.json the check runner reads
 * (its name, scripts and CLI entry), validated at the disk boundary.
 * Invariant: an absent, unreadable or invalid package.json is `null`, never
 * a throw, so a failing package stays a reported result.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const PackageJsonSchema = z.object({
  name: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  main: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});
export type PackageJson = z.infer<typeof PackageJsonSchema>;

/** Reads and validates package.json in `dir`; null when absent or invalid. */
export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = PackageJsonSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
