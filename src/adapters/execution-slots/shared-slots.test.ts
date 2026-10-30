/**
 * The abort path of the shared slots: a waiter whose signal aborts leaves
 * the queue, so a later release goes to the next waiter.
 */

import { expect, test } from 'bun:test';

import { SharedSlots } from './shared-slots';

test('an aborted waiter rejects at once and the released slot goes to the next waiter', async () => {
  const slots = new SharedSlots(1);
  const first = await slots.acquire('a', new AbortController().signal);
  const leaving = new AbortController();
  const aborted = slots.acquire('b', leaving.signal);
  const next = slots.acquire('c', new AbortController().signal);
  leaving.abort();
  await expect(aborted).rejects.toThrow(/run b/);
  slots.release(first);
  expect(await next).toEqual({ runId: 'c' });
});
