/**
 * The examples of a practice spec, as the end-to-end run checks them
 * against the delivered CLI. The examples are the first fenced block of the
 * spec that holds a line starting with `$ `: such a line is a command, the
 * lines after it up to the next command or a blank line are its expected
 * standard output, and a line `(exit code N)` gives its exit code (0 when
 * absent). A malformed block is an error value naming the line, never a
 * silently shorter list. For an error example (a non-zero exit code) only
 * the exit code and the `<command>: ` prefix of the first standard-error
 * line are compared; otherwise standard output must match exactly.
 */

/** One example command with what the spec says it prints. */
export interface SpecExample {
  readonly command: string;
  readonly expectedStdout: string;
  readonly expectedExitCode: number;
}

/** The parsed examples, or why the block could not be read. */
export type ParsedExamples =
  | { readonly ok: true; readonly examples: readonly SpecExample[] }
  | { readonly ok: false; readonly error: string };

/** What one example command did. `exitCode` is null when it was killed. */
export interface ExampleRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const FENCE = /^```/;
const EXIT_CODE_LINE = /^\(exit code (.*)\)$/;

interface Draft {
  command: string;
  stdout: string;
  exitCode: number | undefined;
}

/** Find the fenced example block: [first content line index, closing fence index], or an error. */
function findBlock(lines: readonly string[]): { start: number; end: number } | string {
  let open: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (!FENCE.test(line)) continue;
    if (open === undefined) {
      open = index;
      continue;
    }
    if (lines.slice(open + 1, index).some((inner) => inner.startsWith('$ '))) return { start: open + 1, end: index };
    open = undefined;
  }
  if (open !== undefined) return `the fenced block opened at line ${open + 1} is not closed`;
  return 'no fenced block with a `$ ` command line';
}

/** Parse the example block of a spec. */
export function parseExamples(markdown: string): ParsedExamples {
  const lines = markdown.split('\n');
  const block = findBlock(lines);
  if (typeof block === 'string') return { ok: false, error: block };
  const examples: SpecExample[] = [];
  let draft: Draft | undefined;
  const close = (): void => {
    if (draft !== undefined) examples.push({ command: draft.command, expectedStdout: draft.stdout, expectedExitCode: draft.exitCode ?? 0 });
    draft = undefined;
  };
  for (let index = block.start; index < block.end; index += 1) {
    const line = lines[index] ?? '';
    const where = `line ${index + 1}`;
    if (line.startsWith('$ ')) {
      close();
      const command = line.slice(2).trim();
      if (command === '') return { ok: false, error: `${where}: empty command` };
      draft = { command, stdout: '', exitCode: undefined };
      continue;
    }
    if (line.trim() === '') {
      close();
      continue;
    }
    if (draft === undefined) return { ok: false, error: `${where}: output before any command` };
    if (draft.exitCode !== undefined) return { ok: false, error: `${where}: output after the exit code line` };
    const exit = EXIT_CODE_LINE.exec(line);
    if (exit === null) {
      draft.stdout += `${line}\n`;
      continue;
    }
    const code = exit[1] ?? '';
    if (!/^\d+$/.test(code)) return { ok: false, error: `${where}: exit code "${code}" is not an integer` };
    draft.exitCode = Number(code);
  }
  close();
  return { ok: true, examples };
}

/** Why an example run differs from the spec, or null when it matches. */
export function compareExample(example: SpecExample, commandName: string, run: ExampleRun): string | null {
  const problems: string[] = [];
  if (run.exitCode !== example.expectedExitCode) {
    problems.push(`exit code ${run.exitCode ?? 'none (killed)'}, expected ${example.expectedExitCode}`);
  }
  if (example.expectedExitCode !== 0) {
    const first = run.stderr.split('\n')[0] ?? '';
    const prefix = `${commandName}: `;
    if (!first.startsWith(prefix))
      problems.push(`stderr first line ${JSON.stringify(first)} does not start with ${JSON.stringify(prefix)}`);
  } else if (run.stdout !== example.expectedStdout) {
    problems.push(`stdout ${JSON.stringify(run.stdout)}, expected ${JSON.stringify(example.expectedStdout)}`);
  }
  return problems.length === 0 ? null : problems.join('; ');
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Rewrite a shell command so every invocation of `commandName` runs `node <binPath>` instead. */
export function toNodeCommand(line: string, commandName: string, binPath: string): string {
  const name = commandName.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocation = new RegExp(`(^|[|;&(]\\s*)${name}(?=\\s|$)`, 'g');
  return line.replaceAll(invocation, (_match, lead: string) => `${lead}node ${shellQuote(binPath)}`);
}

/** Shell builtins and utilities that feed or post-process the tool in an example, never the tool itself. */
const SHELL_UTILITIES: ReadonlySet<string> = new Set([
  'cat',
  'cd',
  'echo',
  'env',
  'export',
  'false',
  'grep',
  'head',
  'printf',
  'set',
  'sort',
  'tail',
  'tee',
  'test',
  'time',
  'true',
  'uniq',
  'xargs',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The command words of an example, one per segment, in order: env assignments skipped, utilities dropped. */
function commandWords(command: string): string[] {
  const words: string[] = [];
  for (const segment of command.split(/[|;&()]/)) {
    const word = segment
      .trim()
      .split(/\s+/)
      .find((token) => token.length > 0 && !ENV_ASSIGNMENT.test(token));
    if (word !== undefined && !SHELL_UTILITIES.has(word)) words.push(word);
  }
  return words;
}

/** The word with the most votes; the first one voted wins a tie. */
function mostVoted(votes: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The command the examples invoke (the package's bin). Each example votes
 * for the command word of its last segment that is not a shell utility
 * (`printf 'a\n' | upcase` votes `upcase`). With the delivered package's
 * bin names, a command word of the examples that is one of them wins over
 * the vote. `undefined` with no examples or no command word.
 */
export function commandNameOf(examples: readonly SpecExample[], binNames: readonly string[] = []): string | undefined {
  const words = examples.map((example) => commandWords(example.command));
  const bins = new Set(binNames);
  const lastWords = words.flatMap((list) => list.slice(-1));
  return (
    mostVoted(lastWords.filter((word) => bins.has(word))) ??
    mostVoted(words.flat().filter((word) => bins.has(word))) ??
    mostVoted(lastWords)
  );
}
