/**
 * Failure paths of the HTTP examples: malformed blocks are errors naming
 * the line, and a spec's HTTP examples become ordered example checks after
 * its shell examples.
 */

import { describe, expect, test } from 'bun:test';

import { AcceptanceCheckSchema } from './acceptance';
import { specExampleChecks } from './spec-examples';
import { parseHttpExamples } from './spec-http-examples';

const fence = '```';

function errorOf(markdown: string): string {
  const result = parseHttpExamples(markdown);
  return result.ok ? '' : result.error;
}

describe('parseHttpExamples', () => {
  test('rejects an example without a status line', () => {
    expect(errorOf(`${fence}\nGET /a\n{"x":1}\n${fence}\n`)).toContain('no `=> <status>` line');
  });

  test('rejects a status that is not an HTTP status code', () => {
    expect(errorOf(`${fence}\nGET /a\n=> 2000\n${fence}\n`)).toContain('block line 2');
  });

  test('rejects a response body that is not JSON', () => {
    expect(errorOf(`${fence}\nGET /a\n=> 200\nhello\n${fence}\n`)).toContain('not JSON');
  });

  test('rejects text before the first request line', () => {
    expect(errorOf(`${fence}\nstray\nGET /a\n=> 200\n${fence}\n`)).toContain('block line 1');
  });

  test('rejects a second request body line', () => {
    expect(errorOf(`${fence}\nPOST /a\n{}\n{}\n=> 201\n${fence}\n`)).toContain('second request body');
  });
});

describe('specExampleChecks', () => {
  test('HTTP examples become HTTP checks after the shell examples, in order, a JSON body sent as JSON', () => {
    const markdown = [
      `${fence}\n$ tool a\n1\n${fence}`,
      `${fence}\nPOST /n\n{"t":"x"}\n=> 201\n{"id":1}\n\nPOST /n\nnot json\n=> 400\n\nDELETE /n/1\n=> 204\n${fence}`,
    ].join('\n\n');
    const checks = specExampleChecks(markdown);
    expect(checks.map((check) => [check.id, check.kind])).toEqual([
      ['spec-example-1', 'command'],
      ['spec-example-2', 'http'],
      ['spec-example-3', 'http'],
      ['spec-example-4', 'http'],
    ]);
    for (const check of checks) expect(AcceptanceCheckSchema.safeParse(check).success).toBe(true);
    const [, json, text, del] = checks;
    expect(json?.kind === 'http' ? [json.headers, json.expectedBody] : json).toEqual([
      { 'content-type': 'application/json' },
      { kind: 'exactJson', value: { id: 1 } },
    ]);
    expect(text?.kind === 'http' ? [text.headers, text.body] : text).toEqual([undefined, 'not json']);
    expect(del?.kind === 'http' ? del.expectedBody : del).toBeUndefined();
  });

  test('a malformed HTTP block yields no HTTP example checks', () => {
    expect(specExampleChecks(`${fence}\nGET /a\n=> 999\n${fence}\n`)).toEqual([]);
  });
});
