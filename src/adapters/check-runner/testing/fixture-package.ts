/**
 * Fixture packages for the check-runner tests: small real packages written
 * into temporary directories, so the steps and checks run against real
 * commands on disk. Every fixture is removed by `cleanupFixturePackages`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const created: string[] = [];

/** Writes the given files into a fresh temporary package directory. */
export async function fixturePackage(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-core-check-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

/** Removes every fixture directory this process created. */
export async function cleanupFixturePackages(): Promise<void> {
  const dirs = [...created];
  created.length = 0;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
