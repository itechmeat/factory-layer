/**
 * The child environments never carry a provider key: the gateway, Z.ai and
 * fallback keys set in the factory's own environment stay out of generated
 * code and git.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { generatedCodeEnv, gitEnv } from './child-env';

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
