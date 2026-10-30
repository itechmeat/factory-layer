import { describe, expect, test } from 'bun:test';

import { AcceptanceCheckSchema, type AcceptanceCheck } from './acceptance';
import {
  contradictionWithExamples,
  extractExampleChecks,
  isSpecExampleCheckId,
  runsNoPackageCommand,
  specExampleProblems,
  unquotedParts,
} from './spec-examples';

const SPEC = [
  '# upcase',
  '',
  'Prints its input in upper case, one line per word.',
  '',
  '## Examples',
  '',
  '```',
  "$ printf 'a b\\n' | upcase",
  'A',
  'B',
  '',
  '$ upcase --bad',
  'upcase: unknown option --bad',
  '(exit code 2)',
  '',
  '$ printf "" | upcase',
  '',
  '$ curl -s http://localhost:3000/health',
  'ok',
  '```',
  '',
].join('\n');

function check(input: Record<string, unknown>): AcceptanceCheck {
  return AcceptanceCheckSchema.parse({ id: 'derived', description: 'a derived check', ...input });
}

describe('extractExampleChecks', () => {
  test('turns each shell example into a command check: stdout for exit 0, stderr otherwise, network examples skipped', () => {
    const checks = extractExampleChecks(SPEC);
    expect(checks.map((example) => example.id)).toEqual(['spec-example-1', 'spec-example-2', 'spec-example-3']);
    expect(checks[0]).toMatchObject({
      command: "printf 'a b\\n' | upcase",
      expectedExitCode: 0,
      expectedStdout: { kind: 'exact', value: 'A\nB\n' },
      source: "$ printf 'a b\\n' | upcase\nA\nB",
    });
    expect(checks[1]).toMatchObject({
      command: 'upcase --bad',
      expectedExitCode: 2,
      expectedStderr: { kind: 'substring', value: 'upcase: unknown option --bad' },
    });
    expect(checks[1]?.expectedStdout).toBeUndefined();
    expect(checks[2]).toMatchObject({ command: 'printf "" | upcase', expectedStdout: { kind: 'exact', value: '' } });
    for (const example of checks) {
      expect(isSpecExampleCheckId(example.id)).toBe(true);
      expect(SPEC).toContain(example.source ?? 'missing');
    }
  });

  test('a spec without fenced shell examples yields no checks', () => {
    expect(extractExampleChecks('# tool\n\n```\ntool [options]\n```\n')).toEqual([]);
  });
});

describe('unquotedParts', () => {
  test('a verbatim quote, whitespace aside, is in the spec; passages may be joined by ...', () => {
    expect(unquotedParts(SPEC, 'Prints its input in upper case,\n   one line per word.')).toEqual([]);
    expect(unquotedParts(SPEC, 'Prints its input ... one line per word.')).toEqual([]);
  });

  test('a paraphrase or an empty quote is reported', () => {
    expect(unquotedParts(SPEC, 'Prints the input in capitals.')).toEqual(['Prints the input in capitals.']);
    expect(unquotedParts(SPEC, '  ')).toEqual(['  ']);
  });
});

describe('contradictionWithExamples', () => {
  const examples = extractExampleChecks(SPEC);

  test('a CLI check with the same input but another expected stdout contradicts the example', () => {
    const wrong = check({ kind: 'cli', args: [], stdin: 'a b\n', expectedExitCode: 0, expectedStdout: { kind: 'exact', value: 'a\nb\n' } });
    expect(contradictionWithExamples(wrong, examples)).toContain('contradicts spec-example-1');
  });

  test('a command check of the same command with another exit code contradicts the example', () => {
    const wrong = check({ kind: 'command', command: 'upcase   --bad', expectedExitCode: 1 });
    expect(contradictionWithExamples(wrong, examples)).toContain('exit code must be 2');
  });

  test('agreeing checks and checks of other inputs do not contradict', () => {
    const agrees = check({ kind: 'cli', args: [], stdin: 'a b\n', expectedExitCode: 0, expectedStdout: { kind: 'substring', value: 'B' } });
    const other = check({ kind: 'cli', args: [], stdin: 'x\n', expectedExitCode: 0, expectedStdout: { kind: 'exact', value: 'Y\n' } });
    expect(contradictionWithExamples(agrees, examples)).toBeNull();
    expect(contradictionWithExamples(other, examples)).toBeNull();
  });

  test('an echo producer and a continued command line are understood; other shell forms are not compared', () => {
    const spec = ['```', '$ echo hi | upcase \\', '  --loud', 'HI', '```', '```', '$ upcase < in.txt', 'X', '```'].join('\n');
    const [continued, redirected] = extractExampleChecks(spec);
    expect(continued?.command).toBe('echo hi | upcase \\\n  --loud');
    const viaEcho = check({ kind: 'cli', args: [], stdin: 'hi\n', expectedExitCode: 3 });
    expect(
      contradictionWithExamples(
        viaEcho,
        [redirected].filter((example) => example !== undefined),
      ),
    ).toBeNull();
    const plain = extractExampleChecks(['```', '$ echo hi | upcase', 'HI', '```'].join('\n'));
    expect(contradictionWithExamples(viaEcho, plain)).toContain('exit code must be 0');
  });
});

describe('runsNoPackageCommand', () => {
  const examples = extractExampleChecks(SPEC);

  test('a command check that never names the tool the examples run, nor a runtime, runs nothing of the package', () => {
    const broken = check({ kind: 'command', command: 'printf "\'tis don\'t"\\n', expectedExitCode: 0 });
    expect(runsNoPackageCommand(broken, examples)).toContain('upcase');
  });

  test('a command check that runs the tool or a runtime, a CLI check, or a spec without examples is not flagged', () => {
    expect(
      runsNoPackageCommand(check({ kind: 'command', command: 'd=$(mktemp -d) && upcase "$d/x"', expectedExitCode: 1 }), examples),
    ).toBeNull();
    expect(
      runsNoPackageCommand(check({ kind: 'command', command: 'node -e "process.exit(0)"', expectedExitCode: 0 }), examples),
    ).toBeNull();
    expect(runsNoPackageCommand(check({ kind: 'cli', args: [], expectedExitCode: 0 }), examples)).toBeNull();
    expect(runsNoPackageCommand(check({ kind: 'command', command: 'true', expectedExitCode: 0 }), [])).toBeNull();
  });
});

describe('specExampleProblems', () => {
  test('names a malformed HTTP example block instead of dropping it silently', () => {
    const markdown = ['# api', '', '```', 'GET /items', '```', ''].join('\n');
    const problems = specExampleProblems(markdown);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('HTTP examples');
    expect(problems[0]).toContain('GET /items');
  });

  test('is empty for a spec with no HTTP block or a well formed one', () => {
    expect(specExampleProblems(SPEC)).toEqual([]);
    expect(specExampleProblems(['# api', '', '```', 'GET /items', '=> 200', '```', ''].join('\n'))).toEqual([]);
  });
});
