/**
 * The spec as the ground truth of the acceptance checks: the spec's own
 * shell examples (`$ command`, the expected output, an optional
 * `(exit code N)` line, inside fenced blocks) become command checks without
 * any model, followed by its HTTP examples as HTTP checks
 * (`spec-http-examples.ts`), a model-derived check must quote the spec in its `source`, and
 * a derived check that runs the same invocation as an example but expects
 * something else contradicts that example. Examples that need a network
 * service (`curl`, `wget`, a URL, `localhost`) are left to the model. A
 * malformed HTTP example block gives no checks and is named by
 * `specExampleProblems`, so the caller reports it. Pure text rules, no IO.
 */

import type { AcceptanceCheck, CommandCheck, ExpectedText } from './acceptance';
import { DEFAULT_CHECK_TIMEOUT_MS } from './acceptance';
import { hasHttpExamples, httpExampleChecks, parseHttpExamples } from './spec-http-examples';

/** The id prefix of the checks taken from the spec's examples; derived checks may not use it. */
export const SPEC_EXAMPLE_ID_PREFIX = 'spec-example-';

/** True for the id of a check taken from a spec example. */
export function isSpecExampleCheckId(id: string): boolean {
  return id.startsWith(SPEC_EXAMPLE_ID_PREFIX);
}

const FENCE = /^\s*(?:```|~~~)/;
const PROMPT = /^\$ (.+)$/;
const EXIT_LINE = /^\(exit (?:code|status) (\d+)\)$/i;
const NETWORK = /(?:^|[\s|;&(])(?:curl|wget|http)(?:\s|$)|[a-z]+:\/\/|\blocalhost\b|\b127\.0\.0\.1\b/i;

/** One example as written: the command, its output lines and its raw text in the spec. */
interface Example {
  command: string;
  readonly output: string[];
  readonly raw: string[];
  continued: boolean;
}

/** The lines of every fenced block, the fence's indentation removed. */
function fencedBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  let indent = 0;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      if (current === null) {
        current = [];
        indent = line.length - line.trimStart().length;
      } else {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    current?.push(line.slice(Math.min(indent, line.length - line.trimStart().length)));
  }
  return blocks;
}

/** The examples of one block: each `$ ` line starts one, the lines up to the next are its output. */
function examplesOf(block: readonly string[]): Example[] {
  const examples: Example[] = [];
  for (const line of block) {
    const current = examples.at(-1);
    if (current?.continued === true) {
      current.command += `\n${line}`;
      current.raw.push(line);
      current.continued = line.endsWith('\\');
      continue;
    }
    const prompt = PROMPT.exec(line);
    if (prompt?.[1] !== undefined) {
      examples.push({ command: prompt[1], output: [], raw: [line], continued: prompt[1].endsWith('\\') });
      continue;
    }
    current?.output.push(line);
    current?.raw.push(line);
  }
  return examples;
}

function trimTrailingBlank(lines: string[]): void {
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
}

/** The check of one example, or null for one that needs the network. */
function exampleCheck(example: Example, index: number): CommandCheck | null {
  if (NETWORK.test(example.command)) return null;
  trimTrailingBlank(example.output);
  trimTrailingBlank(example.raw);
  const exit = EXIT_LINE.exec((example.output.at(-1) ?? '').trim());
  if (exit !== null) {
    example.output.pop();
    trimTrailingBlank(example.output);
  }
  const exitCode = exit?.[1] === undefined ? 0 : Number(exit[1]);
  const text = example.output.length === 0 ? '' : `${example.output.join('\n')}\n`;
  const streams =
    exitCode === 0
      ? { expectedStdout: { kind: 'exact', value: text } satisfies ExpectedText }
      : text === ''
        ? {}
        : { expectedStderr: { kind: 'substring', value: example.output.join('\n') } satisfies ExpectedText };
  return {
    kind: 'command',
    id: `${SPEC_EXAMPLE_ID_PREFIX}${String(index)}`,
    description: `Spec example: ${example.command}`,
    source: example.raw.join('\n'),
    timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    command: example.command,
    expectedExitCode: exitCode,
    ...streams,
  };
}

/**
 * The spec's shell examples as command checks, in spec order: exit code
 * from `(exit code N)` (0 when absent); for exit 0 the output is expected
 * exactly on standard output, otherwise it must appear on standard error
 * (Unix convention: errors go to standard error; a message may carry more,
 * such as the system's reason); an example without output asserts no
 * stream.
 */
export function extractExampleChecks(markdown: string): CommandCheck[] {
  const checks: CommandCheck[] = [];
  for (const example of fencedBlocks(markdown).flatMap((block) => examplesOf(block))) {
    const check = exampleCheck(example, checks.length + 1);
    if (check !== null) checks.push(check);
  }
  return checks;
}

/** Every example check of the spec: the shell examples, then the HTTP examples in order (none when their block is malformed). */
export function specExampleChecks(markdown: string): AcceptanceCheck[] {
  const shell = extractExampleChecks(markdown);
  const http = parseHttpExamples(markdown);
  return http.ok ? [...shell, ...httpExampleChecks(http.examples, SPEC_EXAMPLE_ID_PREFIX, shell.length + 1)] : shell;
}

/** Why an example block of the spec gives no checks: today only a malformed HTTP block. Empty when every block reads. */
export function specExampleProblems(markdown: string): string[] {
  if (!hasHttpExamples(markdown)) return [];
  const http = parseHttpExamples(markdown);
  return http.ok ? [] : [`HTTP examples are malformed and give no checks: ${http.error}`];
}

// ---- quotes ----

/** Text with every whitespace run made one space and the ends trimmed. */
export function normalizeWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * The parts of a `source` quote that are not in the spec, whitespace
 * normalized; quotes of separate passages are joined by `...`. An empty
 * source is one missing part.
 */
export function unquotedParts(markdown: string, source: string): string[] {
  const spec = normalizeWhitespace(markdown);
  const parts = source
    .split(/\.\.\.|…/)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part !== '');
  if (parts.length === 0) return [source];
  return parts.filter((part) => !spec.includes(part));
}

// ---- invocations and contradictions ----

/** What a command line runs: the text it pipes in (or none) and the arguments of the program. */
interface Invocation {
  readonly stdin: string;
  readonly args: readonly string[];
}

const SHELL_UTILITIES = new Set(['printf', 'echo', 'cat', 'node', 'bun', 'npm', 'npx', 'sh', 'bash', 'test', 'cd', 'mktemp']);

/** Shell words of a simple command line split at unquoted pipes, or null for anything beyond quotes, words and pipes. */
function shellWords(line: string): string[][] | null {
  const commands: string[][] = [[]];
  let word: string | null = null;
  let index = 0;
  const push = (): void => {
    if (word !== null) commands.at(-1)?.push(word);
    word = null;
  };
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) return null;
      word = (word ?? '') + line.slice(index + 1, end);
      index = end + 1;
    } else if (char === '"') {
      let value = '';
      index += 1;
      while (index < line.length && line.charAt(index) !== '"') {
        const next = line.charAt(index + 1);
        if (line.charAt(index) === '\\' && '$`"\\'.includes(next) && next !== '') {
          value += next;
          index += 2;
        } else if ('$`'.includes(line.charAt(index))) {
          return null;
        } else {
          value += line.charAt(index);
          index += 1;
        }
      }
      if (index >= line.length) return null;
      word = (word ?? '') + value;
      index += 1;
    } else if (/\s/.test(char)) {
      push();
      index += 1;
    } else if (char === '|') {
      push();
      commands.push([]);
      index += 1;
    } else if (/[;&<>$`(){}\\*?[\]~#]/.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
      index += 1;
    }
  }
  push();
  return commands.some((command) => command.length === 0) ? null : commands;
}

const PRINTF_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };

/** The output of `printf FORMAT` without arguments, or null for directives it would expand. */
function printfOutput(format: string): string | null {
  let out = '';
  for (let index = 0; index < format.length; index += 1) {
    const char = format.charAt(index);
    const next = format.charAt(index + 1);
    if (char === '\\' || char === '%') {
      const escaped = char === '\\' ? PRINTF_ESCAPES[next] : next === '%' ? '%' : undefined;
      if (escaped === undefined) return null;
      out += escaped;
      index += 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** The text a `printf` or `echo` producer writes, or null for any other producer. */
function producedText(words: readonly string[]): string | null {
  const [program, ...args] = words;
  if (program === 'printf') return args.length === 1 && args[0] !== undefined ? printfOutput(args[0]) : null;
  if (program !== 'echo') return null;
  const noNewline = args[0] === '-n';
  const text = (noNewline ? args.slice(1) : args).join(' ');
  if (text.includes('\\') || args[0] === '-e') return null;
  return noNewline ? text : `${text}\n`;
}

/** The invocation of the package's command in `printf ... | cmd args` or `cmd args`, or null. */
function invocationOf(command: string): Invocation | null {
  const commands = shellWords(command);
  if (commands === null || commands.length > 2) return null;
  const program = commands.at(-1) ?? [];
  if (program[0] === undefined || SHELL_UTILITIES.has(program[0])) return null;
  const producer = commands.length === 2 ? commands[0] : undefined;
  const stdin = producer === undefined ? '' : producedText(producer);
  return stdin === null ? null : { stdin, args: program.slice(1) };
}

function sameInvocation(a: Invocation, b: Invocation): boolean {
  return a.stdin === b.stdin && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index]);
}

/** Why `candidate` cannot hold where the example's exact text holds, or null when it can. */
function textConflict(stream: string, example: ExpectedText | undefined, candidate: ExpectedText | undefined): string | null {
  if (example?.kind !== 'exact' || candidate === undefined) return null;
  const actual = example.value;
  if (candidate.kind === 'exact' && candidate.value !== actual) return `${stream} must be ${JSON.stringify(actual)}`;
  if (candidate.kind === 'substring' && !actual.includes(candidate.value)) return `${stream} must be ${JSON.stringify(actual)}`;
  if (candidate.kind === 'regex') {
    try {
      if (!new RegExp(candidate.pattern).test(actual)) return `${stream} must be ${JSON.stringify(actual)}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether `check` runs the same invocation as `example`. */
function runsExample(check: AcceptanceCheck, example: CommandCheck): boolean {
  if (check.kind === 'command' && normalizeWhitespace(check.command) === normalizeWhitespace(example.command)) return true;
  const exampleRun = invocationOf(example.command);
  if (exampleRun === null || check.kind === 'http') return false;
  const checkRun = check.kind === 'cli' ? { stdin: check.stdin ?? '', args: check.args } : invocationOf(check.command);
  return checkRun !== null && sameInvocation(checkRun, exampleRun);
}

/**
 * The contradiction between a derived check and the example it runs again:
 * a different exit code or an expected stream the example's exact output
 * cannot satisfy. Null when the check runs no example or agrees with it.
 */
export function contradictionWithExamples(check: AcceptanceCheck, examples: readonly CommandCheck[]): string | null {
  if (check.kind === 'http') return null;
  for (const example of examples) {
    if (!runsExample(check, example)) continue;
    const conflicts = [
      check.expectedExitCode === example.expectedExitCode ? null : `exit code must be ${String(example.expectedExitCode)}`,
      textConflict('stdout', example.expectedStdout, check.expectedStdout),
      textConflict('stderr', example.expectedStderr, check.expectedStderr),
    ].filter((conflict): conflict is string => conflict !== null);
    if (conflicts.length > 0) return `contradicts ${example.id} (${example.command}): ${conflicts.join('; ')}`;
  }
  return null;
}

/** The runtimes a check may use to reach the package instead of its command (`node -e` loading an export, for example). */
const PACKAGE_RUNTIMES = ['node', 'bun', 'npm', 'npx'];

/** The commands the examples run: the first word of each example's last pipeline stage. */
function exampleCommands(examples: readonly CommandCheck[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const example of examples) {
    const program = shellWords(example.command)?.at(-1)?.[0];
    if (program !== undefined && !SHELL_UTILITIES.has(program)) names.add(program);
  }
  return names;
}

/**
 * Why a command check cannot exercise the package: it names none of the
 * commands the spec examples run and no runtime. Null when it names one,
 * for other check kinds, and when the examples name no command.
 */
export function runsNoPackageCommand(check: AcceptanceCheck, examples: readonly CommandCheck[]): string | null {
  if (check.kind !== 'command') return null;
  const commands = exampleCommands(examples);
  if (commands.size === 0) return null;
  const words = new Set(check.command.split(/[^\w.@/-]+/));
  if ([...commands, ...PACKAGE_RUNTIMES].some((name) => words.has(name))) return null;
  return `the command never runs the package: it names none of ${[...commands].map((name) => `\`${name}\``).join(', ')} or a runtime`;
}
