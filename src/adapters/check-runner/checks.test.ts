import { afterAll, describe, expect, test } from 'bun:test';

import { AcceptanceCheckSchema, type AcceptanceCheck } from '../../domain/acceptance';
import { ProcessCheckRunner } from './check-runner';
import { cleanupFixturePackages, fixturePackage } from './testing/fixture-package';

afterAll(cleanupFixturePackages);

const CLI_TS = `
const arg = process.argv[2];
if (arg === 'scream') {
  process.stdout.write('LOUD OUT\\n');
  process.stderr.write('LOUD ERR\\n');
  process.exit(2);
} else if (arg === 'stdin') {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => process.stdout.write('stdin:' + Buffer.concat(chunks).toString()));
} else if (arg === 'slow') {
  setTimeout(() => process.exit(0), 5000);
} else if (arg === 'version') {
  process.stdout.write('version 1.2.3\\n');
} else {
  process.stdout.write('ok\\n');
}
`;

/** Parses a check through the boundary schema, so the type defaults apply. */
function asCheck(input: Record<string, unknown>): AcceptanceCheck {
  return AcceptanceCheckSchema.parse(input);
}

async function fixtureCli(packageJson: Record<string, unknown>): Promise<string> {
  return fixturePackage({ 'package.json': JSON.stringify({ name: 'cli-fixture', private: true, ...packageJson }), 'cli.ts': CLI_TS });
}

describe('ProcessCheckRunner.runChecks, CLI checks', () => {
  test('a matching CLI check passes', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const results = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({
        id: 'cli-ok',
        description: 'plain run',
        kind: 'cli',
        args: [],
        expectedExitCode: 0,
        expectedStdout: { kind: 'exact', value: 'ok\n' },
      }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.checkId).toBe('cli-ok');
    expect(results[0]?.status).toBe('passed');
    expect(results[0]?.reasons).toEqual([]);
    expect(results[0]?.detail).toBe('stdout:\nok\n');
  });

  test('a wrong exit code fails naming expected and actual', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cli-exit', description: 'wrong exit', kind: 'cli', args: [], expectedExitCode: 2 }),
    ]);
    expect(result?.status).toBe('failed');
    expect(result?.reasons.join(' ')).toContain('expected exit code 2');
    expect(result?.reasons.join(' ')).toContain('got 0');
  });

  test('a stdout mismatch is named with expected and actual', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({
        id: 'cli-out',
        description: 'wrong stdout',
        kind: 'cli',
        args: [],
        expectedExitCode: 0,
        expectedStdout: { kind: 'exact', value: 'different' },
      }),
    ]);
    expect(result?.status).toBe('failed');
    const reason = result?.reasons.join(' ') ?? '';
    expect(reason).toContain('stdout');
    expect(reason).toContain('different');
    expect(reason).toContain('ok');
  });

  test('stderr is matched independently and a missing expectation passes its stream', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const runner = new ProcessCheckRunner();
    const [passing] = await runner.runChecks(dir, [
      asCheck({
        id: 'cli-err',
        description: 'stderr only',
        kind: 'cli',
        args: ['scream'],
        expectedExitCode: 2,
        expectedStderr: { kind: 'substring', value: 'LOUD ERR' },
      }),
    ]);
    expect(passing?.status).toBe('passed');

    const [failing] = await runner.runChecks(dir, [
      asCheck({
        id: 'cli-both',
        description: 'stdout too',
        kind: 'cli',
        args: ['scream'],
        expectedExitCode: 2,
        expectedStdout: { kind: 'substring', value: 'quiet' },
      }),
    ]);
    expect(failing?.status).toBe('failed');
    const reason = failing?.reasons.join(' ') ?? '';
    expect(reason).toContain('stdout');
    expect(reason).toContain('quiet');
    expect(reason).toContain('LOUD OUT');
    expect(reason).not.toContain('stderr');
  });

  test('a regex expectation matches, and an invalid regex fails without throwing', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const runner = new ProcessCheckRunner();
    const [passing] = await runner.runChecks(dir, [
      asCheck({
        id: 'cli-re',
        description: 'version regex',
        kind: 'cli',
        args: ['version'],
        expectedExitCode: 0,
        expectedStdout: { kind: 'regex', pattern: '^version \\d+\\.\\d+' },
      }),
    ]);
    expect(passing?.status).toBe('passed');

    // The boundary schema refuses this regex; the runner still must not throw on one that skipped it.
    const broken: AcceptanceCheck = {
      id: 'cli-re-bad',
      description: 'broken regex',
      kind: 'cli',
      args: ['version'],
      expectedExitCode: 0,
      expectedStdout: { kind: 'regex', pattern: '(unclosed' },
      timeoutMs: 30_000,
    };
    const [failing] = await runner.runChecks(dir, [broken]);
    expect(failing?.status).toBe('failed');
    expect(failing?.reasons.join(' ')).toContain('invalid regex');
  });

  test('stdin reaches the CLI', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({
        id: 'cli-stdin',
        description: 'piped input',
        kind: 'cli',
        args: ['stdin'],
        stdin: 'pipe-text',
        expectedExitCode: 0,
        expectedStdout: { kind: 'exact', value: 'stdin:pipe-text' },
      }),
    ]);
    expect(result?.status).toBe('passed');
  });

  test('a slow CLI is killed at its own timeout and fails', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const started = performance.now();
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cli-slow', description: 'hangs', kind: 'cli', args: ['slow'], timeoutMs: 300, expectedExitCode: 0 }),
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result?.status).toBe('failed');
    expect(result?.reasons.join(' ')).toContain('timed out');
  });

  test('bin as an object with one key is the entry', async () => {
    const dir = await fixtureCli({ bin: { mycli: './cli.ts' } });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cli-bin-obj', description: 'one bin', kind: 'cli', args: [], expectedExitCode: 0 }),
    ]);
    expect(result?.status).toBe('passed');
  });

  test('main is the entry when bin is absent', async () => {
    const dir = await fixtureCli({ main: 'cli.ts' });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cli-main', description: 'main entry', kind: 'cli', args: [], expectedExitCode: 0 }),
    ]);
    expect(result?.status).toBe('passed');
  });

  test('no bin and no main fails with a no CLI entry reason', async () => {
    const none = await fixtureCli({});
    const [empty] = await new ProcessCheckRunner().runChecks(none, [
      asCheck({ id: 'cli-none', description: 'no entry', kind: 'cli', args: [], expectedExitCode: 0 }),
    ]);
    expect(empty?.status).toBe('failed');
    expect(empty?.reasons.join(' ')).toContain('no CLI entry');

    const two = await fixtureCli({ bin: { a: './cli.ts', b: './cli.ts' } });
    const [ambiguous] = await new ProcessCheckRunner().runChecks(two, [
      asCheck({ id: 'cli-two-bins', description: 'two bins', kind: 'cli', args: [], expectedExitCode: 0 }),
    ]);
    expect(ambiguous?.status).toBe('failed');
    expect(ambiguous?.reasons.join(' ')).toContain('no CLI entry');
  });

  test('a CLI check on a missing directory resolves with a failed result, not a throw', async () => {
    const dir = await fixtureCli({ bin: 'cli.ts' });
    const [result] = await new ProcessCheckRunner().runChecks('/nonexistent-fcr-dir-xyz', [
      asCheck({ id: 'cli-missing-dir', description: 'no such dir', kind: 'cli', args: [], expectedExitCode: 0 }),
    ]);
    expect(result?.status).toBe('failed');
    expect(result?.reasons.join(' ')).toContain('no CLI entry');
    expect(dir).not.toBe('');
  });
});

describe('ProcessCheckRunner.runChecks, command checks', () => {
  test('a command check passes on the expected exit code and runs in the package dir', async () => {
    const dir = await fixturePackage({ 'package.json': JSON.stringify({ name: 'cmd-fixture', private: true }) });
    const [passing] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cmd-ok', description: 'exit five', kind: 'command', command: 'exit 5', expectedExitCode: 5 }),
    ]);
    expect(passing?.status).toBe('passed');

    const [inDir] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cmd-pwd', description: 'runs in the package dir', kind: 'command', command: 'pwd', expectedExitCode: 0 }),
    ]);
    expect(inDir?.detail).toBe(`stdout:\n${dir}\n`);
  });

  test('a command check sees an allowlisted environment: no factory variable, a scratch HOME', async () => {
    const dir = await fixturePackage({ 'package.json': JSON.stringify({ name: 'cmd-fixture', private: true }) });
    process.env['FACTORY_SENTINEL_KEY'] = 'sentinel-value';
    try {
      const [result] = await new ProcessCheckRunner().runChecks(dir, [
        asCheck({
          id: 'cmd-env',
          description: 'prints its environment',
          kind: 'command',
          command: 'echo "sentinel=${FACTORY_SENTINEL_KEY:-unset} home=$HOME ci=$CI"',
          expectedExitCode: 0,
        }),
      ]);
      expect(result?.detail).toContain('sentinel=unset');
      expect(result?.detail).not.toContain(`home=${process.env['HOME'] ?? ''}\n`);
      expect(result?.detail).toContain('ci=1');
    } finally {
      delete process.env['FACTORY_SENTINEL_KEY'];
    }
  });

  test('a bin name that is not one plain file name gets no shim and is named in the result', async () => {
    const dir = await fixturePackage({
      'package.json': JSON.stringify({
        name: 'cmd-fixture',
        private: true,
        bin: { '../escape': 'cli.js', '..': 'cli.js', good: 'cli.js' },
      }),
      'cli.js': "process.stdout.write('good ran\\n');",
    });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cmd-bins', description: 'runs the safe bin', kind: 'command', command: 'good', expectedExitCode: 0 }),
    ]);
    expect(result?.status).toBe('passed');
    expect(result?.detail).toContain('skipped unsafe bin names: "../escape", ".."');
    expect(result?.detail).toContain('good ran');
  });

  test('a wrong command exit code fails naming expected and actual', async () => {
    const dir = await fixturePackage({ 'package.json': JSON.stringify({ name: 'cmd-fixture', private: true }) });
    const [result] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({ id: 'cmd-bad', description: 'wrong code', kind: 'command', command: 'exit 5', expectedExitCode: 0 }),
    ]);
    expect(result?.status).toBe('failed');
    const reason = result?.reasons.join(' ') ?? '';
    expect(reason).toContain('expected exit code 0');
    expect(reason).toContain('got 5');
  });

  test('a command check with expected streams fails naming each mismatching stream', async () => {
    const dir = await fixturePackage({ 'package.json': JSON.stringify({ name: 'cmd-fixture', private: true }) });
    const [passed, failed] = await new ProcessCheckRunner().runChecks(dir, [
      asCheck({
        id: 'cmd-streams-ok',
        description: 'both streams match',
        kind: 'command',
        command: "printf 'out\\n'; printf 'err\\n' >&2",
        expectedExitCode: 0,
        expectedStdout: { kind: 'exact', value: 'out\n' },
        expectedStderr: { kind: 'exact', value: 'err\n' },
      }),
      asCheck({
        id: 'cmd-streams-bad',
        description: 'stdout differs',
        kind: 'command',
        command: "printf 'other\\n'",
        expectedExitCode: 0,
        expectedStdout: { kind: 'exact', value: 'out\n' },
      }),
    ]);
    expect(passed?.status).toBe('passed');
    expect(failed?.status).toBe('failed');
    expect(failed?.reasons.join(' ')).toContain('stdout: expected exact "out\\n", got "other\\n"');
  });
});
