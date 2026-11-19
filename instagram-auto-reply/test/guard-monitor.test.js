import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { monitorRateLimits, getNavigationStatus } from '../src/guard.js';

const response = (status, frame) => ({
  url: () => 'https://www.instagram.com/tntsportsbr/', status: () => status,
  request: () => ({ isNavigationRequest: () => true, resourceType: () => 'document', frame }),
  allHeaders: async () => ({ 'retry-after': '30' }),
});

test('navegação antes de existir frame não encerra o monitor nem deixa de registrar HTTP 429', async () => {
  const context = new EventEmitter();
  const limits = [];
  const stop = monitorRateLimits(context, info => limits.push(info));
  const listener = context.listeners('response')[0];
  const unavailable = () => { throw new Error('Frame for this navigation request is not available'); };
  await assert.doesNotReject(listener(response(200, unavailable)));
  await assert.doesNotReject(listener(response(429, unavailable)));
  assert.equal(limits.length, 1);
  assert.equal(limits[0].waitMs, 30000);
  assert.equal(limits[0].visiblePage, false);
  stop();
  assert.equal(context.listenerCount('response'), 0);
});

test('navegação principal continua registrando status e restrições; iframe não altera status da página', async () => {
  const context = new EventEmitter();
  const limits = [];
  const page = {};
  const stop = monitorRateLimits(context, info => limits.push(info));
  const listener = context.listeners('response')[0];
  await listener(response(503, () => ({ parentFrame: () => null, page: () => page })));
  assert.equal(getNavigationStatus(page), 503);
  await listener(response(429, () => ({ parentFrame: () => ({}), page: () => page })));
  assert.equal(getNavigationStatus(page), 503);
  assert.equal(limits[0].visiblePage, false);
  await listener(response(429, () => ({ parentFrame: () => null, page: () => page })));
  assert.equal(getNavigationStatus(page), 429);
  assert.equal(limits[1].visiblePage, true);
  stop();
});
