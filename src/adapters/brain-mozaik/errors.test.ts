import { describe, expect, test } from 'bun:test';

import { BrainError, classifyProviderError, type ProviderFailure } from './errors';

const KEY = 'sk-test-secret-123';
const redact = [KEY, ''];
const where = { provider: 'zai', model: 'glm' };

function statusError(status: number, message = 'failed'): Error {
  return Object.assign(new Error(message), { status });
}

describe('classifyProviderError', () => {
  const cases: [number | undefined, ProviderFailure, boolean][] = [
    [401, 'auth', false],
    [403, 'auth', false],
    [400, 'request', false],
    [404, 'request', false],
    [422, 'request', false],
    [408, 'unavailable', true],
    [429, 'rate_limit', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
    [undefined, 'network', true],
  ];
  for (const [status, failure, retryable] of cases) {
    test(`status ${String(status)} is ${failure}, retryable ${String(retryable)}`, () => {
      const error = classifyProviderError(status === undefined ? new Error('socket hang up') : statusError(status), where, redact);
      expect(error).toBeInstanceOf(BrainError);
      expect(error.kind).toBe('provider');
      expect(error.failure).toBe(failure);
      expect(error.retryable).toBe(retryable);
      expect(error.status).toBe(status);
      expect(error.provider).toBe('zai');
      expect(error.model).toBe('glm');
    });
  }

  test('the key is redacted from the message and the cause', () => {
    const error = classifyProviderError(statusError(401, `Incorrect API key provided: ${KEY}`), where, redact);
    expect(error.message).toContain('[redacted]');
    expect(Bun.inspect(error)).not.toContain(KEY);
    expect(JSON.stringify({ message: error.message, cause: String(error.cause) })).not.toContain(KEY);
  });

  test('a thrown non-error value is still classified and redacted', () => {
    const error = classifyProviderError(`raw ${KEY}`, where, redact);
    expect(error.failure).toBe('network');
    expect(error.message).not.toContain(KEY);
  });
});
