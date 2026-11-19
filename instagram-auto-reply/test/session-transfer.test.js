import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { attachSessionExport, validateSessionSnapshot, waitForSessionInitialization } from '../src/session-transfer.js';

const snapshot = () => ({ username: 'golsdodia.galo', cookies: [
  { name: 'sessionid', value: 'test-session', domain: '.instagram.com', path: '/' },
  { name: 'ds_user_id', value: '123', domain: '.instagram.com', path: '/' },
] });

test('sessão recebida deve pertencer à conta esperada e ter cookies válidos do Instagram', () => {
  const source = snapshot();
  const validated = validateSessionSnapshot(source, source.username);
  assert.deepEqual(validated, source);
  assert.notEqual(validated.cookies, source.cookies);
  assert.notEqual(validated.cookies[0], source.cookies[0]);
  for (const invalid of [null, { ...source, username: 'gabrieldastip' },
    { ...source, cookies: [] }, { ...source, cookies: source.cookies.slice(1) },
    { ...source, cookies: [...source.cookies, { name: 'other', value: 'secret', domain: 'notinstagram.com' }] }]) {
    assert.throws(() => validateSessionSnapshot(invalid, source.username), /Sessão recebida/);
  }
});

test('inicialização aguarda a sessão correta e remove os listeners ao recebê-la', async () => {
  const ipc = new EventEmitter();
  const pending = waitForSessionInitialization(ipc, 'golsdodia.galo', 100);
  ipc.emit('message', { type: 'resume' });
  ipc.emit('message', { type: 'session-init', ...snapshot() });
  assert.deepEqual(await pending, snapshot());
  assert.equal(ipc.listenerCount('message'), 0);
  assert.equal(ipc.listenerCount('disconnect'), 0);
});

test('sessão de outra conta, desligamento e timeout não liberam a inicialização', async () => {
  for (const event of ['wrong-account', 'disconnect', 'shutdown', 'timeout']) {
    const ipc = new EventEmitter();
    const pending = waitForSessionInitialization(ipc, 'golsdodia.galo', 10);
    const rejected = assert.rejects(pending);
    if (event === 'wrong-account') ipc.emit('message', { type: 'session-init', ...snapshot(), username: 'other' });
    else if (event === 'disconnect') ipc.emit('disconnect');
    else if (event === 'shutdown') ipc.emit('message', 'shutdown');
    await rejected;
    assert.equal(ipc.listenerCount('message'), 0);
    assert.equal(ipc.listenerCount('disconnect'), 0);
  }
});

test('exportação só responde a pedidos de sessão e não expõe detalhes de erros', async () => {
  const ipc = new EventEmitter();
  ipc.connected = true;
  const sent = [];
  ipc.send = (message) => sent.push(message);
  const detach = attachSessionExport(ipc, async () => snapshot());
  ipc.emit('message', { type: 'resume' });
  ipc.emit('message', { type: 'session-snapshot-request', requestId: '1:1' });
  await delay(0);
  assert.deepEqual(sent, [{ type: 'session-snapshot', requestId: '1:1', ...snapshot() }]);
  detach();
  const detachError = attachSessionExport(ipc, async () => { throw new Error('secret-session-value'); });
  ipc.emit('message', { type: 'session-snapshot-request', requestId: '1:2' });
  await delay(0);
  assert.equal(sent.at(-1).error, 'Sessão ativa indisponível.');
  assert.ok(!JSON.stringify(sent.at(-1)).includes('secret-session-value'));
  detachError();
  assert.equal(ipc.listenerCount('message'), 0);
});
