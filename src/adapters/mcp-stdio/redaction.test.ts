import { describe, expect, test } from 'bun:test';

import { redactSecrets, StderrTail } from './redaction';

describe('redactSecrets', () => {
  test('replaces every occurrence of every secret', () => {
    expect(redactSecrets('a s3cret b s3cret c tok', ['s3cret', 'tok'])).toBe('a [redacted] b [redacted] c [redacted]');
  });

  test('ignores empty secrets and leaves text without secrets unchanged', () => {
    expect(redactSecrets('plain text', ['', 'absent'])).toBe('plain text');
  });

  test('redacts the longer of two overlapping secrets whole', () => {
    expect(redactSecrets('key=abcdef', ['abc', 'abcdef'])).toBe('key=[redacted]');
  });
});

describe('StderrTail', () => {
  test('keeps everything below the limit, redacted', () => {
    const tail = new StderrTail(['hush'], 100);
    tail.append('one hush ');
    tail.append('two');
    expect(tail.text()).toBe('one [redacted] two');
  });

  test('keeps only the last characters past the limit', () => {
    const tail = new StderrTail([], 5);
    tail.append('abcdefghij');
    expect(tail.text()).toBe('fghij');
  });

  test('redacts a secret added later and keeps room for it at the cut', () => {
    const tail = new StderrTail([], 6);
    tail.addSecret('TOKEN12');
    tail.append('aaTOKEN12bb');
    // Without the margin the raw cut would keep the secret's tail ('EN12bb').
    expect(tail.text()).toBe('ted]bb');
  });

  test('never exposes a secret split by the cut or by chunking', () => {
    const tail = new StderrTail(['SECRETVALUE'], 8);
    tail.append('xxxxSECRET');
    tail.append('VALUEyy');
    for (let i = 0; i < 3; i += 1) tail.append('SECRETVALUE'.slice(i * 4, i * 4 + 4));
    const shown = tail.text();
    expect(shown.length).toBeLessThanOrEqual(8);
    for (let start = 0; start + 4 <= 'SECRETVALUE'.length; start += 1) {
      expect(shown).not.toContain('SECRETVALUE'.slice(start, start + 4));
    }
  });
});
