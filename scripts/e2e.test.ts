/**
 * Failure paths of the end-to-end run script that a real run cannot
 * reproduce on demand: a malformed example block in the spec and a
 * delivered CLI whose output or exit code differs from an example.
 */

import { describe, expect, test } from 'bun:test';

import { commandNameOf, compareExample, parseExamples, toNodeCommand } from './e2e-examples';
import { parseRunId } from './e2e-report';
import { factoryGraceMs, OutputCapture } from './e2e';

const fence = '```';

/** The error of a parse that must fail; an empty string when it did not. */
function errorOf(result: ReturnType<typeof parseExamples>): string {
  return result.ok ? '' : result.error;
}

describe('parseExamples', () => {
  test('rejects a spec with no example block', () => {
    const result = parseExamples('# tool\n\nNo examples here.\n');
    expect(result.ok).toBe(false);
  });

  test('rejects an unterminated example block', () => {
    const result = parseExamples(`## Examples\n\n${fence}\n$ tool a\n1\n`);
    expect(errorOf(result)).toContain('not closed');
  });

  test('rejects output that comes before any command', () => {
    const result = parseExamples(`${fence}\nstray output\n$ tool a\n1\n${fence}\n`);
    expect(errorOf(result)).toContain('line 2');
  });

  test('rejects an exit code line that is not an integer', () => {
    const result = parseExamples(`${fence}\n$ tool a\ntool: bad\n(exit code two)\n${fence}\n`);
    expect(errorOf(result)).toContain('exit code');
  });

  test('rejects output after the exit code line', () => {
    const result = parseExamples(`${fence}\n$ tool a\ntool: bad\n(exit code 2)\nmore\n${fence}\n`);
    expect(result.ok).toBe(false);
  });

  test('rejects an empty command', () => {
    const result = parseExamples(`${fence}\n$ \n1\n${fence}\n`);
    expect(result.ok).toBe(false);
  });
});

describe('compareExample', () => {
  const ok = { command: 'tool', expectedStdout: '2\tthe\n', expectedExitCode: 0 };
  const err = { command: 'tool --x', expectedStdout: 'tool: bad option\n', expectedExitCode: 2 };

  test('reports a stdout mismatch', () => {
    const mismatch = compareExample(ok, 'tool', { exitCode: 0, stdout: '1\tthe\n', stderr: '' });
    expect(mismatch).toContain('stdout');
  });

  test('reports a missing trailing newline as a mismatch', () => {
    expect(compareExample(ok, 'tool', { exitCode: 0, stdout: '2\tthe', stderr: '' })).not.toBeNull();
  });

  test('reports a wrong exit code', () => {
    const mismatch = compareExample(ok, 'tool', { exitCode: 1, stdout: '2\tthe\n', stderr: '' });
    expect(mismatch).toContain('exit code');
  });

  test('reports an error example whose stderr lacks the command prefix', () => {
    const mismatch = compareExample(err, 'tool', { exitCode: 2, stdout: '', stderr: 'Error: bad\n' });
    expect(mismatch).toContain('stderr');
  });

  test('reports an error example with the wrong exit code', () => {
    const mismatch = compareExample(err, 'tool', { exitCode: 1, stdout: '', stderr: 'tool: other\n' });
    expect(mismatch).toContain('exit code');
  });

  test('reports a process killed by its timeout', () => {
    const mismatch = compareExample(ok, 'tool', { exitCode: null, stdout: '2\tthe\n', stderr: '' });
    expect(mismatch).toContain('exit code');
  });
});

describe('toNodeCommand', () => {
  test('replaces the command only where it is invoked, not inside arguments', () => {
    const line = "printf 'tool tool\\n' | tool --top 1 && tool x";
    expect(toNodeCommand(line, 'tool', '/p/bin.js')).toBe("printf 'tool tool\\n' | node '/p/bin.js' --top 1 && node '/p/bin.js' x");
  });
});

describe('commandNameOf', () => {
  test('takes the command the examples invoke, not the spec file name', () => {
    const examples = [
      { command: 'wc-lite a.txt', expectedStdout: '', expectedExitCode: 0 },
      { command: "printf 'x' | wc-lite", expectedStdout: '', expectedExitCode: 0 },
      { command: 'wc-lite --help', expectedStdout: '', expectedExitCode: 0 },
    ];
    expect(commandNameOf(examples)).toBe('wc-lite');
    expect(commandNameOf([])).toBeUndefined();
  });

  test('takes the last pipeline segment, not a utility that feeds it, even with one example', () => {
    const only = [{ command: "printf 'a\\n' | upcase", expectedStdout: 'A\n', expectedExitCode: 0 }];
    expect(commandNameOf(only)).toBe('upcase');
    const withEnv = [{ command: 'echo hi | LANG=C upcase --loud | cat', expectedStdout: '', expectedExitCode: 0 }];
    expect(commandNameOf(withEnv)).toBe('upcase');
  });

  test('prefers a name that is one of the delivered bin keys', () => {
    const examples = [
      { command: 'helper a | sorter', expectedStdout: '', expectedExitCode: 0 },
      { command: 'helper b', expectedStdout: '', expectedExitCode: 0 },
    ];
    expect(commandNameOf(examples)).toBe('sorter');
    expect(commandNameOf(examples, ['helper'])).toBe('helper');
    expect(commandNameOf(examples, ['unrelated'])).toBe('sorter');
  });
});

describe('OutputCapture', () => {
  test('keeps the run id line and the report path even after the output was cut', () => {
    const capture = new OutputCapture(100);
    capture.add('run id: wordfreq-20261030t100000z-ab12\n');
    capture.add('x'.repeat(10_000));
    capture.add('\nreport: /tmp/runs/r/report.md\noutcome: succeeded\n');
    expect(parseRunId(capture.text())).toBe('wordfreq-20261030t100000z-ab12');
    expect(capture.text()).toContain('outcome: succeeded');
    expect(capture.text().length).toBeLessThan(400);
  });
});

describe('factoryGraceMs', () => {
  test('the grace after the factory timeout never runs past the deadline', () => {
    expect(factoryGraceMs(2.5 * 60_000)).toBeLessThanOrEqual(2.5 * 60_000);
    expect(factoryGraceMs(60 * 60_000)).toBe(5 * 60_000);
  });
});
