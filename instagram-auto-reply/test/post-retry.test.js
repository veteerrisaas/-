import test from 'node:test';
import assert from 'node:assert/strict';
import { PostRetryQueue } from '../src/post-retry.js';

test('todos indisponíveis aguardam um minuto para buscar posts novos', () => {
  const queue = new PostRetryQueue();
  queue.defer('one', 'leitura recusada', 1000);
  queue.defer('two', 'comentários indisponíveis', 2000);
  assert.equal(queue.idleWait(['one', 'two'], 3000), 60_000);
  assert.equal(queue.get('one', 3000).reason, 'leitura recusada');
  // Consultar não renova o adiamento: os 30 minutos não começam de novo a cada ciclo.
  assert.equal(queue.get('one', 4000).retryAt, 1_801_000);
});

test('um post novo pode ser tratado sem esperar os outros', () => {
  const queue = new PostRetryQueue();
  queue.defer('old', 'erro HTTP', 1000);
  assert.equal(queue.idleWait(['old', 'new'], 2000), 0);
  assert.equal(queue.get('old', 2000).retryAt, 1_801_000);
  assert.equal(queue.get('new', 2000), null);
});

test('retoma no vencimento do primeiro post, mesmo antes de um minuto', () => {
  const queue = new PostRetryQueue({ retryMs: 90_000 });
  queue.defer('first', 'HTTP 429', 1000);
  queue.defer('second', 'erro de leitura', 20_000);
  assert.equal(queue.idleWait(['first', 'second'], 90_000), 1000);
  assert.equal(queue.idleWait(['first', 'second'], 91_000), 0);
  assert.equal(queue.get('first', 91_000), null);
  assert.ok(queue.get('second', 91_000));
});

test('lista vazia não é tratada como todos os posts indisponíveis', () => {
  assert.equal(new PostRetryQueue().idleWait([], 1000), 0);
});
