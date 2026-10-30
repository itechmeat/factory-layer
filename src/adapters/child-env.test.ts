/**
 * The child environments never carry a provider key: the gateway, Z.ai and
 * fallback keys set in the factory's own environment stay out of generated
 * code and git.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { fallbackLang, generatedCodeEnv, gitEnv } from './child-env';

const KEYS = ['JIGJOY_ANTHROPIC_API_KEY', 'JIGJOY_ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'FALLBACK_API_KEY'];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of KEYS) {
    saved.set(name, process.env[name]);
    process.env[name] = `secret-${name}`;
  }
});

afterEach(() => {
  for (const name of KEYS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('no provider key reaches generated code or git', () => {
  for (const env of [generatedCodeEnv('/tmp/home', { PORT: '1' }), gitEnv()]) {
    const text = JSON.stringify(env);
    for (const name of KEYS) {
      expect(Object.keys(env)).not.toContain(name);
      expect(text).not.toContain(`secret-${name}`);
    }
  }
});

test('the fallback LANG is a locale the platform always ships', () => {
  expect(fallbackLang('darwin')).toBe('en_US.UTF-8');
  expect(fallbackLang('linux')).toBe('C.UTF-8');
});

test('generated code gets the fallback LANG only when the factory has none', () => {
  const factoryLang = process.env['LANG'];
  try {
    delete process.env['LANG'];
    expect(generatedCodeEnv('/tmp/home')['LANG']).toBe(fallbackLang(process.platform));
    process.env['LANG'] = 'de_DE.UTF-8';
    expect(generatedCodeEnv('/tmp/home')['LANG']).toBe('de_DE.UTF-8');
  } finally {
    if (factoryLang === undefined) delete process.env['LANG'];
    else process.env['LANG'] = factoryLang;
  }
});
