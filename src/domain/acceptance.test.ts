import { describe, expect, test } from 'bun:test';

import { DEFAULT_CHECK_TIMEOUT_MS, AcceptanceCheckSchema, CheckResultSchema, ExpectedTextSchema, HttpCheckSchema } from './acceptance';

describe('AcceptanceCheckSchema', () => {
  test('a check without a timeout gets the default of 30 s', () => {
    const check = AcceptanceCheckSchema.parse({
      kind: 'cli',
      id: 'cli-adds',
      description: 'adding two numbers prints the sum',
      args: ['add', '2', '3'],
      expectedExitCode: 0,
    });
    expect(check.timeoutMs).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(check.timeoutMs).toBe(30_000);
  });

  test('parses an HTTP check with headers and an exact JSON body', () => {
    const check = HttpCheckSchema.parse({
      kind: 'http',
      id: 'http-list',
      description: 'listing returns the items',
      method: 'GET',
      path: '/items',
      headers: { accept: 'application/json' },
      expectedStatus: 200,
      expectedBody: { kind: 'exactJson', value: { items: [] } },
    });
    expect(check.kind).toBe('http');
    expect(check.headers).toEqual({ accept: 'application/json' });
    expect(check.expectedBody).toEqual({ kind: 'exactJson', value: { items: [] } });
  });

  test('parses a command check and fills the default timeout', () => {
    expect(
      AcceptanceCheckSchema.parse({
        kind: 'command',
        id: 'cmd-build',
        description: 'the build script exits zero',
        command: 'bun run build',
        expectedExitCode: 0,
      }),
    ).toEqual({
      kind: 'command',
      id: 'cmd-build',
      description: 'the build script exits zero',
      timeoutMs: 30_000,
      command: 'bun run build',
      expectedExitCode: 0,
    });
  });

  test('a CLI check without an id fails with an error naming the path', () => {
    const parsed = AcceptanceCheckSchema.safeParse({
      kind: 'cli',
      description: 'adding two numbers prints the sum',
      args: [],
      expectedExitCode: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('id');
    }
  });

  test.each(['@example.com/x', '//example.com/x', 'items', ''])('an HTTP path %j that could leave the server is rejected', (path) => {
    const base = { kind: 'http', id: 'http-x', description: 'x', method: 'GET', expectedStatus: 200 };
    expect(HttpCheckSchema.safeParse({ ...base, path }).success).toBe(false);
    expect(HttpCheckSchema.safeParse({ ...base, path: '/items?q=1' }).success).toBe(true);
  });

  test('a check of an unknown kind is rejected', () => {
    expect(() => AcceptanceCheckSchema.parse({ kind: 'sql', id: 'sql-one', description: 'a query' })).toThrow();
  });
});

describe('CheckResultSchema', () => {
  test('parses a passed result', () => {
    expect(CheckResultSchema.parse({ checkId: 'cli-adds', status: 'passed', reasons: [], detail: '' })).toEqual({
      checkId: 'cli-adds',
      status: 'passed',
      reasons: [],
      detail: '',
    });
  });

  test('rejects a status outside passed, failed and errored', () => {
    expect(() => CheckResultSchema.parse({ checkId: 'cli-adds', status: 'skipped', reasons: [], detail: '' })).toThrow();
  });
});

describe('ExpectedTextSchema', () => {
  test('a regex JavaScript cannot compile is refused with the reason', () => {
    const parsed = ExpectedTextSchema.safeParse({ kind: 'regex', pattern: '(?s)wordfreq' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('not a valid JavaScript regular expression');
    expect(ExpectedTextSchema.safeParse({ kind: 'regex', pattern: '^wordfreq[\\s\\S]*' }).success).toBe(true);
  });
});
