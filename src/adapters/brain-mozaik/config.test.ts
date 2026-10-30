import { describe, expect, test } from 'bun:test';

import { BrainConfigError, DEFAULT_ZAI_BASE_URL, DEFAULT_ZAI_MODEL, parseBrainConfig } from './config';

const KEY = 'sk-primary-secret-value';
const FALLBACK_KEY = 'sk-fallback-secret-value';

function failure(env: Record<string, string | undefined>): BrainConfigError {
  try {
    parseBrainConfig(env);
  } catch (error) {
    if (error instanceof BrainConfigError) return error;
    throw error;
  }
  throw new Error('expected parseBrainConfig to fail');
}

describe('parseBrainConfig', () => {
  test('blank optional variables take their defaults', () => {
    const config = parseBrainConfig({ ZAI_API_KEY: KEY, ZAI_BASE_URL: '', ZAI_MODEL: '  ', FALLBACK_API_KEY: '' });
    expect(config.primary.baseUrl).toBe(DEFAULT_ZAI_BASE_URL);
    expect(config.primary.model).toBe(DEFAULT_ZAI_MODEL);
    expect(config.fallback).toBeUndefined();
  });

  test('explicit primary values are kept', () => {
    const config = parseBrainConfig({ ZAI_API_KEY: KEY, ZAI_BASE_URL: 'https://example.test/v1', ZAI_MODEL: 'glm-x' });
    expect(config.primary.baseUrl).toBe('https://example.test/v1');
    expect(config.primary.model).toBe('glm-x');
  });

  test('a complete fallback is configured', () => {
    const config = parseBrainConfig({
      ZAI_API_KEY: KEY,
      FALLBACK_API_KEY: FALLBACK_KEY,
      FALLBACK_BASE_URL: 'https://fallback.test/v1',
      FALLBACK_MODEL: 'other-model',
    });
    expect(config.fallback).toEqual({ name: 'fallback', apiKey: FALLBACK_KEY, baseUrl: 'https://fallback.test/v1', model: 'other-model' });
  });

  for (const value of [undefined, '', '   ']) {
    test(`a missing key (${JSON.stringify(value)}) names ZAI_API_KEY`, () => {
      const error = failure({ ZAI_API_KEY: value });
      expect(error.variable).toBe('ZAI_API_KEY');
      expect(error.message).toContain('ZAI_API_KEY');
    });
  }

  test('an invalid base URL names the variable and does not echo its value', () => {
    const error = failure({ ZAI_API_KEY: KEY, ZAI_BASE_URL: `not a url ${KEY}` });
    expect(error.variable).toBe('ZAI_BASE_URL');
    expect(error.message).not.toContain(KEY);
  });

  for (const [variable, extra] of [
    ['ZAI_BASE_URL', {}],
    ['FALLBACK_BASE_URL', { FALLBACK_API_KEY: FALLBACK_KEY, FALLBACK_MODEL: 'other-model' }],
  ] as const) {
    test(`a non-http(s) ${variable} is rejected naming the variable`, () => {
      const error = failure({ ZAI_API_KEY: KEY, ...extra, [variable]: 'ftp://x' });
      expect(error.variable).toBe(variable);
      expect(error.message).toContain('must be an http(s) URL');
    });
  }

  test('a partial fallback names the missing fallback variable', () => {
    const error = failure({
      ZAI_API_KEY: KEY,
      FALLBACK_API_KEY: FALLBACK_KEY,
      FALLBACK_BASE_URL: 'https://fallback.test/v1',
      FALLBACK_MODEL: '',
    });
    expect(error.variable).toBe('FALLBACK_MODEL');
    expect(error.message).toContain('FALLBACK_MODEL');
  });

  test('a fallback model equal to the primary model names FALLBACK_MODEL', () => {
    const error = failure({
      ZAI_API_KEY: KEY,
      ZAI_MODEL: 'glm-x',
      FALLBACK_API_KEY: FALLBACK_KEY,
      FALLBACK_BASE_URL: 'https://fallback.test/v1',
      FALLBACK_MODEL: 'glm-x',
    });
    expect(error.variable).toBe('FALLBACK_MODEL');
    expect(error.message).toContain('must differ from ZAI_MODEL');
  });

  test('no error message carries a key value', () => {
    const errors = [
      failure({ ZAI_API_KEY: '' }),
      failure({ ZAI_API_KEY: KEY, FALLBACK_API_KEY: FALLBACK_KEY }),
      failure({ ZAI_API_KEY: KEY, FALLBACK_BASE_URL: `bad ${FALLBACK_KEY}`, FALLBACK_API_KEY: FALLBACK_KEY, FALLBACK_MODEL: 'm' }),
    ];
    for (const error of errors) {
      expect(Bun.inspect(error)).not.toContain(KEY);
      expect(Bun.inspect(error)).not.toContain(FALLBACK_KEY);
    }
  });
});
