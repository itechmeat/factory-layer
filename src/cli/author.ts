/**
 * The `factory author <kind> --example <file>` command: reads the operator's
 * example file (only a local file outside the factory's run trees, never a
 * spec or output of a run, since the brain's draft is approved without a
 * human; symlinks of the file and of the trees are resolved first), wires the authoring run on the composed ports, prints its outcome
 * and writes its report (`runs/<run id>/authoring-report.md`: the steps in
 * order, the playbook id and the review's reasons). Exit codes: 0 approved,
 * 3 none found, 1 rejected or failed, 2 a usage error.
 */

import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { systemClock } from '../adapters/index';
import { messageOf } from '../adapters/mcp-stdio/errors';
import { runDir } from '../adapters/trace-fs/read';
import { authorPlaybook, type AuthoringOutcome } from '../application/author-playbook';
import { type AuthoringExample, isAuthoringKind, parseAuthoringExample } from '../domain/authoring';
import { compose, type Env } from './compose';
import { EXIT, newRunId } from './run';

/** The factory's own trees an example file may not come from: what runs read and write. */
const RUN_TREES = ['runs', 'work', 'out', 'hidden'] as const;

/** What the command needs. */
export interface AuthorInput {
  readonly root: string;
  readonly env: Env;
  readonly write: (line: string) => void;
  readonly taskKind: string;
  readonly examplePath: string;
}

/** The authoring report: outcome, playbook, the review's reasons and every step in order. */
export function authoringReport(runId: string, taskKind: string, outcome: AuthoringOutcome): string {
  const lines = [
    `# Authoring run ${runId}`,
    '',
    `- Kind of task: ${taskKind}`,
    `- Result: ${outcome.result}`,
    `- Playbook: ${outcome.playbookId ?? 'none'}`,
    `- Detail: ${outcome.detail}`,
    '',
    '## Review reasons',
    '',
    ...(outcome.reasons.length === 0 ? ['No review was given.'] : outcome.reasons.map((reason) => `- ${reason}`)),
    '',
    '## Steps',
    '',
    ...outcome.steps.map(
      (step, index) =>
        `${String(index + 1)}. ${step.step} ${step.ok ? 'ok' : 'failed'}${step.playbookId === null ? '' : ` (${step.playbookId})`}: ${step.detail.replaceAll('\n', ' ')}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** The real path with every symlink resolved, or the path as given when it does not exist. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `path` is `dir` or below it. */
function isWithin(dir: string, path: string): boolean {
  const inside = relative(dir, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/** The run tree the file lies in, symlinks of the file and of each tree resolved, or undefined. */
function runTreeOf(root: string, path: string): string | undefined {
  const real = realOrSelf(path);
  return RUN_TREES.find((name) => {
    const tree = join(root, name);
    return isWithin(tree, path) || isWithin(realOrSelf(tree), real);
  });
}

/** The parsed example file, or the problem as one line. */
async function readExample(root: string, examplePath: string): Promise<AuthoringExample | string> {
  const path = resolve(examplePath);
  const tree = runTreeOf(resolve(root), path);
  if (tree !== undefined) return `refused: the example file is inside the factory's ${tree}/ tree; name an operator file`;
  try {
    if (!statSync(path).isFile()) return `invalid example: ${examplePath} is not a file`;
    return parseAuthoringExample(await Bun.file(path).text());
  } catch (error) {
    return `invalid example: ${examplePath}: ${messageOf(error)}`;
  }
}

function exitOf(outcome: AuthoringOutcome): number {
  if (outcome.result === 'approved') return EXIT.succeeded;
  if (outcome.result === 'none') return EXIT.partial;
  return EXIT.failed;
}

/** Runs the command and returns the exit code. */
export async function authorCommand(input: AuthorInput): Promise<number> {
  if (!isAuthoringKind(input.taskKind)) {
    input.write(`invalid kind: ${JSON.stringify(input.taskKind)} is not a lowercase slug of at most 40 characters`);
    return EXIT.usage;
  }
  const example = await readExample(input.root, input.examplePath);
  if (typeof example === 'string') {
    input.write(example);
    return EXIT.usage;
  }
  let composition;
  try {
    composition = compose(input.root, input.env, input.write, { replanBudget: 0 });
  } catch (error) {
    input.write(`setup failed: ${messageOf(error)}`);
    return EXIT.failed;
  }
  try {
    const now = systemClock.now();
    const runId = newRunId(`author-${input.taskKind}`, now);
    const outcome = await authorPlaybook(composition.ports, {
      runId,
      taskKind: input.taskKind,
      suffix: now.getTime().toString(36),
      example,
      secrets: composition.secrets,
    });
    input.write(`authoring ${outcome.result}: ${outcome.detail}`);
    if (outcome.playbookId !== null) input.write(`playbook: ${outcome.playbookId}`);
    try {
      const directory = runDir(input.root, runId);
      mkdirSync(directory, { recursive: true });
      const file = join(directory, 'authoring-report.md');
      await Bun.write(file, authoringReport(runId, input.taskKind, outcome));
      input.write(`report: ${file}`);
    } catch (error) {
      input.write(`report failed: ${messageOf(error)}`);
    }
    return exitOf(outcome);
  } finally {
    await composition.close();
  }
}
