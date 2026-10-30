/**
 * The HTTP examples of a practice spec checked against the delivered
 * server. The example format and its parsing are the domain's
 * (`src/domain/spec-http-examples.ts`), shared with the factory's own
 * example checks. The examples run in order against one server, started
 * with `npm run start` in the Node-only environment on a free `PORT` by the
 * check runner's HTTP batch (bounded TCP accept wait on both loopback
 * addresses, one bounded request per example, the process group killed
 * whatever the outcome), and the script's deadline aborts the batch.
 */

import { withScratchHome } from '../src/adapters/child-env';
import { runHttpBatch } from '../src/adapters/check-runner/http';
import { httpExampleChecks, type HttpExample } from '../src/domain/spec-http-examples';
import { remainingMs, type Deadline } from './e2e-process';
import type { ExampleResult } from './e2e-verify';

export { hasHttpExamples, parseHttpExamples, type HttpExample } from '../src/domain/spec-http-examples';

/** Timeout of one example request, in milliseconds. */
export const HTTP_EXAMPLE_TIMEOUT_MS = 10_000;

/** The label of an example in reports: its request line. */
export function exampleLabel(example: HttpExample): string {
  return `${example.method} ${example.path}`;
}

/** Start the delivered server in `dir` (installed and built) and run every example against it, in order. */
export async function runHttpExamples(
  dir: string,
  examples: readonly HttpExample[],
  deadline: Deadline,
): Promise<readonly ExampleResult[]> {
  const checks = httpExampleChecks(examples, 'example-', 1).map((check) => ({ ...check, timeoutMs: HTTP_EXAMPLE_TIMEOUT_MS }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs(deadline));
  try {
    const results = await withScratchHome((home) => runHttpBatch(dir, checks, { secrets: [], home, signal: controller.signal }));
    return examples.map((example, index) => {
      const result = results[index];
      const mismatch = result === undefined ? 'no result' : result.status === 'passed' ? null : result.reasons.join('; ');
      return { command: exampleLabel(example), mismatch };
    });
  } finally {
    clearTimeout(timer);
  }
}
