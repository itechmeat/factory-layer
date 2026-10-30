import { describe, expect, test } from 'bun:test';

import { BrainConfigError, DEFAULT_JIGJOY_MODEL, DEFAULT_ZAI_BASE_URL, DEFAULT_ZAI_MODEL, parseBrainConfig } from './config';

const KEY = 'sk-primary-secret-value';
const FALLBACK_KEY = 'sk-fallback-secret-value';
const GATEWAY_KEY = 'sk-gateway-secret-value';

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
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].baseUrl).toBe(DEFAULT_ZAI_BASE_URL);
    expect(config.providers[0].model).toBe(DEFAULT_ZAI_MODEL);
  });

  test('explicit primary values are kept', () => {
    const config = parseBrainConfig({ ZAI_API_KEY: KEY, ZAI_BASE_URL: 'https://example.test/v1', ZAI_MODEL: 'glm-x' });
    expect(config.providers[0].baseUrl).toBe('https://example.test/v1');
    expect(config.providers[0].model).toBe('glm-x');
  });

  test('a complete fallback is configured', () => {
    const config = parseBrainConfig({
      ZAI_API_KEY: KEY,
      FALLBACK_API_KEY: FALLBACK_KEY,
      FALLBACK_BASE_URL: 'https://fallback.test/v1',
      FALLBACK_MODEL: 'other-model',
    });
    expect(config.providers[1]).toEqual({
      name: 'fallback',
      api: 'openai-chat',
      apiKey: FALLBACK_KEY,
      baseUrl: 'https://fallback.test/v1',
      model: 'other-model',
    });
  });

  test('the JigJoy gateway comes first, then Z.ai, then the fallback, when the flag is on', () => {
    const config = parseBrainConfig({
      ZAI_API_KEY: KEY,
      FACTORY_BRAIN_GATEWAY: '1',
      JIGJOY_ANTHROPIC_API_KEY: GATEWAY_KEY,
      JIGJOY_ANTHROPIC_BASE_URL: 'https://gateway.test/anthropic',
      FALLBACK_API_KEY: FALLBACK_KEY,
      FALLBACK_BASE_URL: 'https://fallback.test/v1',
      FALLBACK_MODEL: 'other-model',
    });
    expect(config.providers.map((provider) => [provider.name, provider.api, provider.model])).toEqual([
      ['jigjoy', 'anthropic-messages', DEFAULT_JIGJOY_MODEL],
      ['zai', 'openai-chat', DEFAULT_ZAI_MODEL],
      ['fallback', 'openai-chat', 'other-model'],
    ]);
    expect(config.providers[0]).toMatchObject({ apiKey: GATEWAY_KEY, baseUrl: 'https://gateway.test/anthropic' });
  });

  test('with the flag off the gateway keys are ignored and Z.ai is primary', () => {
    for (const flag of [undefined, '', '0']) {
      const config = parseBrainConfig({
        ZAI_API_KEY: KEY,
        FACTORY_BRAIN_GATEWAY: flag,
        JIGJOY_ANTHROPIC_API_KEY: GATEWAY_KEY,
        JIGJOY_ANTHROPIC_BASE_URL: 'https://gateway.test/anthropic',
      });
      expect(config.providers.map((provider) => provider.name)).toEqual(['zai']);
    }
  });

  test('with the flag off a half-set gateway pair is not an error', () => {
    const config = parseBrainConfig({ ZAI_API_KEY: KEY, JIGJOY_ANTHROPIC_API_KEY: GATEWAY_KEY });
    expect(config.providers.map((provider) => provider.name)).toEqual(['zai']);
  });

  test('the gateway model can be overridden', () => {
    const config = parseBrainConfig({
      ZAI_API_KEY: KEY,
      FACTORY_BRAIN_GATEWAY: '1',
      JIGJOY_ANTHROPIC_API_KEY: GATEWAY_KEY,
      JIGJOY_ANTHROPIC_BASE_URL: 'https://gateway.test',
      JIGJOY_ANTHROPIC_MODEL: 'claude-haiku-4-5',
    });
    expect(config.providers[0].model).toBe('claude-haiku-4-5');
  });

  test('the ANTHROPIC_* names are never read', () => {
    const config = parseBrainConfig({ ZAI_API_KEY: KEY, ANTHROPIC_API_KEY: GATEWAY_KEY, ANTHROPIC_BASE_URL: 'https://gateway.test' });
    expect(config.providers.map((provider) => provider.name)).toEqual(['zai']);
  });

  for (const [present, missing] of [
    ['JIGJOY_ANTHROPIC_API_KEY', 'JIGJOY_ANTHROPIC_BASE_URL'],
    ['JIGJOY_ANTHROPIC_BASE_URL', 'JIGJOY_ANTHROPIC_API_KEY'],
  ] as const) {
    test(`${present} alone names ${missing} without echoing a value`, () => {
      const value = present === 'JIGJOY_ANTHROPIC_API_KEY' ? GATEWAY_KEY : 'https://gateway.test';
      const error = failure({ ZAI_API_KEY: KEY, FACTORY_BRAIN_GATEWAY: '1', [present]: value });
      expect(error.variable).toBe(missing);
      expect(Bun.inspect(error)).not.toContain(GATEWAY_KEY);
    });
  }

  test('the flag on with no gateway variables names the first missing one', () => {
    const error = failure({ ZAI_API_KEY: KEY, FACTORY_BRAIN_GATEWAY: '1' });
    expect(error.variable).toBe('JIGJOY_ANTHROPIC_API_KEY');
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
