/**
 * Process counting for the check-runner tests: how many live processes
 * match a full-command-line pattern, so a test can prove that nothing it
 * spawned is still running.
 */

import { spawn } from 'node:child_process';

/** Counts processes whose full command line matches the pattern (0 when none). */
export function pgrepCount(pattern: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pgrep', ['-f', pattern], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve(code === 0 ? out.split('\n').filter((line) => line !== '').length : 0);
    });
  });
}

/** Waits until the condition holds, failing after 3 s. */
export async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 3000;
  for (;;) {
    if (await condition()) return;
    if (performance.now() > deadline) throw new Error('condition not met within 3 s');
    await Bun.sleep(50);
  }
}
