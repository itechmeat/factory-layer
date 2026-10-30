import { describe, expect, test } from 'bun:test';

import { requireBinary, requireEnv } from './prerequisites';

describe('requireEnv', () => {
  test('names the missing variable and .env.example', () => {
    expect(() => requireEnv('ZAI_API_KEY', {})).toThrow(/ZAI_API_KEY.*\.env\.example/);
  });

  test('treats an empty value as missing', () => {
    expect(() => requireEnv('ZAI_API_KEY', { ZAI_API_KEY: '' })).toThrow(/ZAI_API_KEY/);
  });
});

describe('requireBinary', () => {
  test('names the missing binary and the PATH', () => {
    expect(() => requireBinary('factory-no-such-binary-xyz')).toThrow(/factory-no-such-binary-xyz.*PATH/);
  });
});
