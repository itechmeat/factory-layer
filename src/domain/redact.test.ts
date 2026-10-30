import { describe, expect, test } from 'bun:test';

import { REDACTED, redactJson, redactString } from './redact';

describe('redactString', () => {
  test('replaces every occurrence of every secret', () => {
    expect(redactString('token abc here and abc again, pwd xyz', ['abc', 'xyz'])).toBe(
      `token ${REDACTED} here and ${REDACTED} again, pwd ${REDACTED}`,
    );
  });

  test('leaves text alone with an empty secret set', () => {
    expect(redactString('plain text', [])).toBe('plain text');
  });

  test('ignores the empty string as a secret', () => {
    expect(redactString('unchanged', [''])).toBe('unchanged');
  });

  test('a longer secret that contains a shorter one is redacted whole', () => {
    expect(redactString('value abcdefgh end', ['abc', 'abcdefgh'])).toBe(`value ${REDACTED} end`);
  });
});

describe('redactJson', () => {
  test('redacts strings nested in objects and arrays and keeps the rest exactly', () => {
    expect(
      redactJson(
        {
          message: 'connect with secret inside',
          count: 42,
          ok: true,
          missing: null,
          nested: { list: ['secret too', 7, false, null, { deep: 'secret deep' }] },
        },
        ['secret'],
      ),
    ).toEqual({
      message: 'connect with [redacted] inside',
      count: 42,
      ok: true,
      missing: null,
      nested: { list: ['[redacted] too', 7, false, null, { deep: '[redacted] deep' }] },
    });
  });

  test('redacts a top-level string', () => {
    expect(redactJson('top secret', ['secret'])).toBe(`top ${REDACTED}`);
  });

  test('keeps object keys as they are', () => {
    expect(redactJson({ secretKey: 'plain' }, ['secret'])).toEqual({ secretKey: 'plain' });
  });

  test('deep-equals the input with an empty secret set', () => {
    const value = { a: [1, 'x', null, { b: true }] };
    expect(redactJson(value, [])).toEqual(value);
  });

  test('does not mutate the input', () => {
    const value = { list: ['a secret'] };
    redactJson(value, ['secret']);
    expect(value.list[0]).toBe('a secret');
  });
});
