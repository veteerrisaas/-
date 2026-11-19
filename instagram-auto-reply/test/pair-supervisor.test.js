import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairSupervisor } from '../src/pair-supervisor.js';
import { Store } from '../src/store.js';
import { FIVE_PAGE_INSTANCES } from '../src/instance-layout.js';

function harness(t, options = {}) {
  const launches = [];
  const supervisor = new PairSupervisor({
    accounts: [{ username: 'first' }, { username: 'second' }],
    instances: ['cazetv-1', 'tntsportsbr-1'],
    restartMs: 1, stopTimeoutMs: 500, heartbeatTimeoutMs: 0, log: () => {},
    launch: (instance, account, session) => {
      const child = new EventEmitter();
      child.connected = true;
      child.sent = [];
      child.send = (message) => child.sent.push(message);
      launches.push({ instance, account, session, child });
      return child;
    },
    ...options,
  });
  t.after(() => {
    supervisor.stop();
    for (const child of [...supervisor.children.keys()]) child.emit('close', 0);
  });
  supervisor.start();
  return { supervisor, launches };
}

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'O acompanhamento não retomou no prazo do teste.');
}

function modeHarness(t, options = {}) {
  return harness(t, { syncBrowserModes: true, browserMode: 'iphone',
    accounts: [{ number: 2, username: 'golsdodia.galo' }], ...options });
}

function readyModes(pair) {
  for (const item of pair) item.child.emit('message', { type: 'ready',
    username: item.account.username, browserMode: item.session.browserMode });
}

test('cinco janelas só enviam após todas confirmarem e fecham juntas antes de trocar o modo', async t => {
  const { supervisor, launches } = modeHarness(t, { instances: FIVE_PAGE_INSTANCES,
    browserMode: 'desktop', accounts: [{ number: 1, username: 'gbrdastip' }] });
  assert.equal(launches.length, 5);
  readyModes(launches.slice(0, 4));
  assert.ok(launches.every(item => !item.child.sent.some(message => message?.type === 'resume')));
  readyModes(launches.slice(4));
  assert.ok(launches.every(item => item.child.sent.at(-1).type === 'resume'));
  launches[0].child.emit('message', readFailure(launches[0]));
  supervisor.pendingMode.waitMs = 0;
  assert.ok(launches.every(item => item.child.sent.at(-1) === 'shutdown'));
  for (const item of launches.slice(0, 4)) item.child.emit('close', 0);
  assert.equal(launches.length, 5);
  launches[4].child.emit('close', 0);
  await until(() => launches.length === 10);
  assert.ok(launches.slice(5).every(item => item.session.browserMode === 'mobile'));
  assert.deepEqual(launches.slice(5).map(item => item.instance), FIVE_PAGE_INSTANCES);
});

function readFailure(item) {
  return { type: 'read-mode-failure', username: item.account.username,
    browserMode: item.session.browserMode, profile: { username: item.instance.slice(0, -2) },
    post: { url: `https://www.instagram.com/${item.instance.slice(0, -2)}/p/TEST/`, code: 'TEST' }, reason: 'Rate limit' };
}

function splitModeHarness(t, options = {}) {
  const primary = { number: 1, username: 'gabrieldastip' };
  const secondary = { number: 2, username: 'golsdodia.galo' };
  return modeHarness(t, { browserMode: 'desktop', accounts: [primary, secondary],
    instanceAccounts: { 'cazetv-1': primary, 'tntsportsbr-1': secondary }, ...options });
}

const sessionCookies = () => [
  { name: 'sessionid', value: 'test-session', domain: '.instagram.com', path: '/' },
  { name: 'ds_user_id', value: '123', domain: '.instagram.com', path: '/' },
];
function returnSession(donor, requestId = donor.child.sent.at(-1).requestId, username = donor.account.username) {
  donor.child.emit('message', { type: 'session-snapshot', requestId, username, cookies: sessionCookies() });
}
const sendFailure = (item) => ({ ...readFailure(item), failureKind: 'send-rejected' });

const gabrielCorreaHarness = (t) => modeHarness(t, { browserMode: 'desktop', alternateAccountsByMode: true,
  accountFirst: true, accounts: [{ number: 1, username: 'gabrieldastip' }, { number: 4, username: 'correa.tipss' }] });

test('Gab percorre desktop, Android e iPhone antes da Correa; ambas sempre sincronizadas', async (t) => {
  const { supervisor, launches } = gabrielCorreaHarness(t);
  const sequence = [['gabrieldastip', 'desktop'], ['gabrieldastip', 'mobile'], ['gabrieldastip', 'iphone'],
    ['correa.tipss', 'desktop'], ['correa.tipss', 'mobile'], ['correa.tipss', 'iphone'], ['gabrieldastip', 'desktop']];
  for (const [index, [username, mode]] of sequence.entries()) {
    const pair = launches.slice(index * 2, index * 2 + 2);
    assert.deepEqual(pair.map((item) => [item.account.username, item.session.browserMode]), [[username, mode], [username, mode]]);
    readyModes(pair.slice(0, 1));
    assert.deepEqual(pair[0].child.sent, []);
    readyModes(pair.slice(1));
    assert.equal(pair[0].child.sent.at(-1).type, 'resume');
    if (index === sequence.length - 1) break;
    pair[0].child.emit('message', index % 2 ? sendFailure(pair[0]) : readFailure(pair[0]));
    supervisor.pendingMode.waitMs = 0;
    pair[0].child.emit('close', 0);
    assert.equal(launches.length, (index + 1) * 2);
    pair[1].child.emit('close', 0);
    await until(() => launches.length === (index + 2) * 2);
  }
});

test('queda da Gab tenta Correa no desktop; se ambas caírem encerra para a espera externa', async (t) => {
  const { supervisor, launches } = gabrielCorreaHarness(t);
  launches[0].child.emit('close', 3);
  assert.equal(launches[1].child.sent.at(-1), 'shutdown');
  launches[1].child.emit('close', 0);
  await until(() => launches.length === 4);
  assert.ok(launches.slice(2).every((item) => item.account.username === 'correa.tipss' && item.session.browserMode === 'desktop'));
  launches[2].child.emit('close', 2);
  assert.equal(supervisor.stopped, true);
  launches[3].child.emit('close', 0);
  assert.equal(supervisor.restartTimer, null);
});

test('Correa que falha na autenticação não impede voltar à Gab e não é repetida a cada dispositivo', async (t) => {
  const { supervisor, launches } = gabrielCorreaHarness(t);
  for (let index = 0; index < 3; index++) {
    const pair = launches.slice(index * 2, index * 2 + 2);
    readyModes(pair);
    pair[0].child.emit('message', readFailure(pair[0]));
    supervisor.pendingMode.waitMs = 0;
    for (const item of pair) item.child.emit('close', 0);
    await until(() => launches.length === (index + 2) * 2);
  }
  assert.equal(launches[6].account.username, 'correa.tipss');
  launches[6].child.emit('close', 2);
  launches[7].child.emit('close', 0);
  await until(() => launches.length === 10);
  for (let index = 4; index < 7; index++) {
    const pair = launches.slice(index * 2, index * 2 + 2);
    readyModes(pair);
    pair[0].child.emit('message', readFailure(pair[0]));
    assert.equal(supervisor.accounts[supervisor.accountIndex].username, 'gabrieldastip');
    supervisor.pendingMode.waitMs = 0;
    for (const item of pair) item.child.emit('close', 0);
    await until(() => launches.length === (index + 2) * 2);
  }
});

for (const failingIndex of [0, 1]) test(`recusa na janela ${failingIndex} troca somente essa conta, mantendo a outra rodando e sem repetir resume`, async (t) => {
  const { supervisor, launches } = splitModeHarness(t, { accountFailover: true });
  readyModes(launches);
  const failing = launches[failingIndex];
  const donor = launches[1 - failingIndex];
  failing.child.emit('message', sendFailure(failing));
  assert.equal(donor.child.sent.at(-1).type, 'session-snapshot-request');
  returnSession(donor);
  await delay(0);
  assert.equal(failing.child.sent.at(-1), 'shutdown');
  assert.ok(!donor.child.sent.includes('shutdown'));
  assert.equal(launches.length, 2, 'A janela antiga ainda não fechou.');
  failing.child.emit('message', sendFailure(failing));
  failing.child.emit('close', 0);
  await until(() => launches.length === 3);
  const replacement = launches[2];
  assert.equal(replacement.instance, failing.instance);
  assert.equal(replacement.account, donor.account);
  assert.equal(replacement.session.browserMode, 'desktop');
  assert.equal(replacement.session.sessionFromParent, true);
  assert.deepEqual(replacement.child.sent, [{ type: 'session-init', username: donor.account.username, cookies: sessionCookies() }]);
  const failure = sendFailure(failing);
  readyModes([replacement]);
  assert.deepEqual(replacement.child.sent.at(-1), { type: 'resume', retryPost: { post: failure.post, profile: failure.profile } });
  assert.equal(donor.child.sent.filter((m) => m?.type === 'resume').length, 1);
  assert.equal(supervisor.modeFallback.failures, 0, 'Recusa não deve avançar o dispositivo.');
  assert.equal(supervisor.browserMode, 'desktop');
});

test('depois da troca de conta, falhas de leitura continuam trocando ambas desktop → Android → iPhone', async (t) => {
  const { supervisor, launches } = splitModeHarness(t, { accountFailover: true });
  readyModes(launches);
  launches[1].child.emit('message', sendFailure(launches[1]));
  returnSession(launches[0]);
  await delay(0);
  launches[1].child.emit('close', 0);
  await until(() => launches.length === 3);
  readyModes([launches[2]]);
  let pair = [launches[0], launches[2]];
  for (const mode of ['mobile', 'iphone']) {
    const before = launches.length;
    for (const item of pair) item.child.emit('message', { type: 'read-mode-success',
      username: item.account.username, browserMode: item.session.browserMode });
    pair[0].child.emit('message', readFailure(pair[0]));
    for (const item of pair) { assert.equal(item.child.sent.at(-1), 'shutdown'); item.child.emit('close', 0); }
    await until(() => launches.length === before + 2);
    pair = launches.slice(-2);
    assert.deepEqual(pair.map((item) => [item.account.username, item.session.browserMode]),
      [['gabrieldastip', mode], ['gabrieldastip', mode]]);
    readyModes(pair);
  }
  assert.equal(supervisor.accountIndex, 0);
});

test('quando ambas já usam a mesma conta, só a página recusada aguarda; a outra continua', async (t) => {
  const { supervisor, launches } = splitModeHarness(t, { accountFailover: true });
  readyModes(launches);
  launches[1].child.emit('message', sendFailure(launches[1]));
  returnSession(launches[0]); await delay(0);
  launches[1].child.emit('close', 0); await until(() => launches.length === 3);
  const replacement = launches[2]; readyModes([replacement]);
  replacement.child.emit('message', sendFailure(replacement)); await delay(0);
  const plan = supervisor.replacements.get(replacement.instance);
  assert.equal(plan.account.username, 'gabrieldastip');
  assert.ok(plan.waitMs > 0);
  assert.ok(!launches[0].child.sent.includes('shutdown'));
  assert.equal(replacement.child.sent.at(-1), 'shutdown');
  assert.equal(supervisor.browserMode, 'desktop');
  assert.equal(supervisor.modeFallback.failures, 0);
  replacement.child.emit('close', 0);
  supervisor.stop();
  assert.equal(supervisor.replacements.size, 0);
  await delay(10); assert.equal(launches.length, 3);
});

test('recusas simultâneas não copiam a sessão de uma conta que também acabou de falhar', async (t) => {
  const { supervisor, launches } = splitModeHarness(t, { accountFailover: true });
  readyModes(launches);
  launches[0].child.emit('message', sendFailure(launches[0]));
  const requestId = launches[1].child.sent.at(-1).requestId;
  launches[1].child.emit('message', sendFailure(launches[1]));
  returnSession(launches[1], requestId); await delay(0);
  for (const item of launches) {
    const plan = supervisor.replacements.get(item.instance);
    assert.equal(plan.account, item.account);
    assert.ok(plan.waitMs > 0);
    assert.equal(plan.cookies, undefined);
    assert.equal(item.child.sent.at(-1), 'shutdown');
  }
  assert.equal(supervisor.browserMode, 'desktop');
});

test('parar durante a transferência cancela o pedido e ignora a sessão que chegar depois', async (t) => {
  const { supervisor, launches } = splitModeHarness(t, { accountFailover: true });
  readyModes(launches);
  launches[1].child.emit('message', sendFailure(launches[1]));
  const requestId = launches[0].child.sent.at(-1).requestId;
  supervisor.stop();
  returnSession(launches[0], requestId); await delay(10);
  assert.equal(supervisor.replacements.size, 0);
  assert.equal(supervisor.sessionRequests.size, 0);
  assert.equal(launches.length, 2);
});

test('uma troca de dispositivo cancela a troca individual pendente sem lançar processos antigos', async (t) => {
  const { supervisor, launches } = splitModeHarness(t, { accountFailover: true });
  readyModes(launches);
  const first = launches.slice();
  first[1].child.emit('message', sendFailure(first[1]));
  const requestId = first[0].child.sent.at(-1).requestId;
  first[0].child.emit('message', readFailure(first[0]));
  returnSession(first[0], requestId);
  for (const item of first) item.child.emit('close', 0);
  await until(() => launches.length === 4);
  assert.deepEqual(launches.slice(2).map((item) => [item.account.username, item.session.browserMode]),
    [['gabrieldastip', 'mobile'], ['golsdodia.galo', 'mobile']]);
  assert.equal(supervisor.replacements.size, 0);
  assert.equal(supervisor.sessionRequests.size, 0);
});

test('sessão de conta errada e timeout de exportação pausam somente a página afetada', async (t) => {
  for (const invalid of ['wrong-account', 'timeout']) await t.test(invalid, async (t) => {
    const { supervisor, launches } = splitModeHarness(t, { accountFailover: true, sessionTimeoutMs: 10 });
    readyModes(launches);
    launches[1].child.emit('message', sendFailure(launches[1]));
    if (invalid === 'wrong-account') returnSession(launches[0], undefined, 'wrong');
    await until(() => supervisor.replacements.get('tntsportsbr-1')?.ready);
    assert.equal(supervisor.replacements.get('tntsportsbr-1').account.username, 'golsdodia.galo');
    assert.ok(supervisor.replacements.get('tntsportsbr-1').waitMs > 0);
    assert.ok(!launches[0].child.sent.includes('shutdown'));
    assert.equal(supervisor.stopped, false);
  });
});

test('contas fixas por destino percorrem os três dispositivos juntas e só retomam após ambas fecharem e confirmarem', async (t) => {
  const { supervisor, launches } = splitModeHarness(t);
  let retry = null;
  for (const [generation, mode] of ['desktop', 'mobile', 'iphone', 'desktop'].entries()) {
    const pair = launches.slice(generation * 2, generation * 2 + 2);
    assert.deepEqual(pair.map((item) => [item.instance, item.account.username, item.session.browserMode]), [
      ['cazetv-1', 'gabrieldastip', mode], ['tntsportsbr-1', 'golsdodia.galo', mode],
    ]);
    readyModes(pair.slice(0, 1));
    assert.deepEqual(pair[0].child.sent, []);
    readyModes(pair.slice(1));
    for (const item of pair) assert.deepEqual(item.child.sent[0], { type: 'resume',
      retryPost: retry?.instance === item.instance ? { post: retry.post, profile: retry.profile } : null });
    if (generation === 3) break;
    for (const item of pair) item.child.emit('message', { type: 'read-mode-success',
      username: item.account.username, browserMode: mode });
    const failing = pair[generation % 2];
    const failure = readFailure(failing);
    retry = { ...failure, instance: failing.instance };
    failing.child.emit('message', failure);
    pair[1 - generation % 2].child.emit('message', readFailure(pair[1 - generation % 2]));
    assert.equal(supervisor.modeFallback.failures, 1);
    assert.equal(supervisor.pendingMode.waitMs, 0);
    for (const item of pair) assert.equal(item.child.sent.at(-1), 'shutdown');
    pair[0].child.emit('close', 0);
    await delay(10);
    assert.equal(launches.length, (generation + 1) * 2);
    pair[1].child.emit('close', 0);
    await until(() => launches.length === (generation + 2) * 2);
    failing.child.emit('message', failure);
    assert.equal(supervisor.generation, generation + 2);
  }
  assert.equal(supervisor.accountIndex, 0);
});

test('conta ou dispositivo incorreto no destino impede retomar o par de contas fixas', async (t) => {
  for (const wrong of [
    { username: 'gabrieldastip', browserMode: 'desktop' },
    { username: 'golsdodia.galo', browserMode: 'mobile' },
  ]) await t.test(JSON.stringify(wrong), (t) => {
    const { supervisor, launches } = splitModeHarness(t);
    readyModes(launches.slice(0, 1));
    launches[1].child.emit('message', { type: 'ready', ...wrong });
    assert.equal(supervisor.stopped, true);
    for (const item of launches) assert.deepEqual(item.child.sent, ['shutdown']);
  });
});

test('falha de leitura atribuída à outra conta não altera o dispositivo nem troca contas', (t) => {
  const { supervisor, launches } = splitModeHarness(t);
  readyModes(launches);
  launches[1].child.emit('message', { ...readFailure(launches[1]), username: 'gabrieldastip' });
  assert.equal(supervisor.stopped, true);
  assert.equal(supervisor.browserMode, 'desktop');
  assert.equal(supervisor.accountIndex, 0);
});

test('ambas intercalam Galo e gabrieldastip em desktop, iPhone e Android e voltam ao início', async (t) => {
  const { supervisor, launches } = modeHarness(t, {
    browserMode: 'desktop', alternateAccountsByMode: true,
    accounts: [{ number: 2, username: 'golsdodia.galo' }, { number: 1, username: 'gabrieldastip' }],
  });
  const sequence = [
    ['golsdodia.galo', 'desktop'], ['gabrieldastip', 'desktop'],
    ['golsdodia.galo', 'iphone'], ['gabrieldastip', 'iphone'],
    ['golsdodia.galo', 'mobile'], ['gabrieldastip', 'mobile'],
    ['golsdodia.galo', 'desktop'],
  ];
  let previousFailure;
  for (const [generation, [username, mode]] of sequence.entries()) {
    const pair = launches.slice(generation * 2, generation * 2 + 2);
    assert.deepEqual(pair.map((item) => [item.account.username, item.session.browserMode]),
      [[username, mode], [username, mode]]);
    readyModes(pair.slice(0, 1));
    assert.deepEqual(pair[0].child.sent, [], 'Uma sessão sozinha não pode retomar.');
    readyModes(pair.slice(1));
    assert.deepEqual(pair[1].child.sent[0], { type: 'resume', retryPost: previousFailure
      ? { post: previousFailure.post, profile: previousFailure.profile } : null });
    assert.deepEqual(pair[0].child.sent[0], { type: 'resume', retryPost: null });
    if (generation === sequence.length - 1) break;
    const failure = readFailure(pair[1]);
    pair[1].child.emit('message', failure);
    pair[0].child.emit('message', readFailure(pair[0]));
    assert.equal(supervisor.modeFallback.failures, generation + 1);
    assert.equal(supervisor.pendingMode.waitMs,
      generation === 0 ? 0 : Math.min(1_800_000, 30_000 * 2 ** (generation - 1)),
      'A troca de conta também deve preservar a espera por falhas consecutivas.');
    assert.equal(supervisor.pendingMode.post, failure.post);
    assert.equal(supervisor.pendingMode.browserMode, sequence[generation + 1][1]);
    previousFailure = failure;
    // Evita aguardar os segundos reais neste teste de sequência e encerramento.
    supervisor.pendingMode.waitMs = 0;
    pair[0].child.emit('close', 0);
    await delay(10);
    assert.equal(launches.length, (generation + 1) * 2);
    pair[1].child.emit('close', 0);
    await until(() => launches.length === (generation + 2) * 2);
    for (const item of pair) item.child.emit('message', readFailure(item));
    assert.equal(supervisor.generation, generation + 2, 'Eventos antigos não podem mudar o novo par.');
  }
});

test('par combinado com conta incorreta encerra sem iniciar outra conta', (t) => {
  const { supervisor, launches } = modeHarness(t, {
    browserMode: 'desktop', alternateAccountsByMode: true,
    accounts: [{ number: 2, username: 'golsdodia.galo' }, { number: 1, username: 'gabrieldastip' }],
  });
  launches[0].child.emit('message', { type: 'ready', username: 'gabrieldastip', browserMode: 'desktop' });
  assert.equal(supervisor.stopped, true);
  assert.equal(supervisor.accountIndex, 0);
  for (const { child } of launches) assert.deepEqual(child.sent, ['shutdown']);
});

test('pausar durante a troca conjunta cancela a retomada da outra conta', async (t) => {
  const { supervisor, launches } = modeHarness(t, {
    browserMode: 'desktop', alternateAccountsByMode: true,
    accounts: [{ number: 2, username: 'golsdodia.galo' }, { number: 1, username: 'gabrieldastip' }],
  });
  readyModes(launches);
  supervisor.modeFallback.failures = 1;
  launches[0].child.emit('message', readFailure(launches[0]));
  assert.equal(supervisor.accountIndex, 1);
  assert.equal(supervisor.browserMode, 'desktop');
  assert.equal(supervisor.pendingMode.waitMs, 30_000);
  for (const { child } of launches) child.emit('close', 0);
  supervisor.stop();
  assert.equal(supervisor.restartTimer, null);
  await delay(20);
  assert.equal(launches.length, 2);
});

test('uma leitura bem-sucedida zera a espera sem mudar a posição no fluxo de contas', async (t) => {
  const { supervisor, launches } = modeHarness(t, {
    browserMode: 'desktop', alternateAccountsByMode: true,
    accounts: [{ number: 2, username: 'golsdodia.galo' }, { number: 1, username: 'gabrieldastip' }],
  });
  readyModes(launches);
  launches[0].child.emit('message', readFailure(launches[0]));
  for (const { child } of launches.slice(0, 2)) child.emit('close', 0);
  await until(() => launches.length === 4);
  const pair = launches.slice(2);
  readyModes(pair);
  for (const item of pair) item.child.emit('message', { type: 'read-mode-success',
    username: item.account.username, browserMode: item.session.browserMode });
  assert.equal(supervisor.modeFallback.failures, 0);
  pair[1].child.emit('message', readFailure(pair[1]));
  assert.equal(supervisor.accountIndex, 0);
  assert.equal(supervisor.browserMode, 'iphone');
  assert.equal(supervisor.pendingMode.waitMs, 0);
});

test('falha no iPhone fecha ambas antes de reabrir no desktop, preservando conta e post a retomar', async (t) => {
  const { supervisor, launches } = modeHarness(t);
  readyModes(launches);
  const failure = readFailure(launches[1]);
  launches[1].child.emit('message', failure);
  for (const { child } of launches) assert.equal(child.sent.at(-1), 'shutdown');
  launches[0].child.emit('close', 0);
  await delay(15);
  assert.equal(launches.length, 2, 'A outra janela antiga ainda está aberta.');
  launches[1].child.emit('close', 0);
  await until(() => launches.length === 4);
  const pair = launches.slice(2);
  assert.deepEqual(pair.map((item) => [item.account.username, item.session.browserMode]),
    [['golsdodia.galo', 'desktop'], ['golsdodia.galo', 'desktop']]);
  readyModes(pair.slice(0, 1));
  assert.deepEqual(pair[0].child.sent, [], 'A primeira janela precisa aguardar a segunda.');
  readyModes(pair.slice(1));
  assert.deepEqual(pair[0].child.sent, [{ type: 'resume', retryPost: null }]);
  assert.deepEqual(pair[1].child.sent, [{ type: 'resume', retryPost: { post: failure.post, profile: failure.profile } }]);
  assert.equal(supervisor.accountIndex, 0);
});

test('duas falhas simultâneas e mensagens antigas causam somente uma mudança de interface', async (t) => {
  const { supervisor, launches } = modeHarness(t);
  readyModes(launches);
  const old = [...launches];
  for (const item of old) item.child.emit('message', readFailure(item));
  assert.equal(supervisor.browserMode, 'desktop');
  assert.equal(supervisor.modeFallback.failures, 1);
  for (const item of old) item.child.emit('close', 0);
  await until(() => launches.length === 4);
  for (const item of old) item.child.emit('message', readFailure(item));
  assert.equal(supervisor.generation, 2);
  assert.equal(supervisor.modeFallback.failures, 1);
});

test('as duas percorrem desktop, Android e iPhone juntas e leituras de ambas reiniciam a espera', async (t) => {
  const { supervisor, launches } = modeHarness(t, { browserMode: 'desktop' });
  for (const [generation, expected] of ['desktop', 'mobile', 'iphone', 'desktop'].entries()) {
    const pair = launches.slice(generation * 2, generation * 2 + 2);
    assert.deepEqual(pair.map((item) => item.session.browserMode), [expected, expected]);
    readyModes(pair);
    if (generation === 3) break;
    for (const item of pair) item.child.emit('message', { type: 'read-mode-success',
      username: item.account.username, browserMode: expected });
    pair[0].child.emit('message', readFailure(pair[0]));
    assert.equal(supervisor.pendingMode.waitMs, 0);
    for (const item of pair) item.child.emit('close', 0);
    await until(() => launches.length === (generation + 2) * 2);
  }
  assert.equal(supervisor.accountIndex, 0);
});

test('sucesso de apenas uma janela não remove a espera após recusas consecutivas; Ctrl+C cancela a retomada', async (t) => {
  const { supervisor, launches } = modeHarness(t);
  readyModes(launches);
  launches[0].child.emit('message', readFailure(launches[0]));
  for (const item of launches.slice(0, 2)) item.child.emit('close', 0);
  await until(() => launches.length === 4);
  const pair = launches.slice(2);
  readyModes(pair);
  pair[0].child.emit('message', { type: 'read-mode-success', username: 'golsdodia.galo', browserMode: 'desktop' });
  pair[1].child.emit('message', readFailure(pair[1]));
  assert.equal(supervisor.pendingMode.waitMs, 30_000);
  for (const item of pair) item.child.emit('close', 0);
  supervisor.stop();
  await delay(20);
  assert.equal(launches.length, 4);
});

test('modo ou conta incorretos impedem liberar qualquer janela no par sincronizado', (t) => {
  const { supervisor, launches } = modeHarness(t);
  launches[0].child.emit('message', { type: 'ready', username: 'golsdodia.galo', browserMode: 'desktop' });
  assert.equal(supervisor.stopped, true);
  assert.equal(supervisor.accountIndex, 0);
  for (const { child } of launches) assert.deepEqual(child.sent, ['shutdown']);
});

test('fechar manualmente uma janela encerra o par sincronizado sem reabrir nem mudar conta', async (t) => {
  const { supervisor, launches } = modeHarness(t);
  readyModes(launches);
  launches[0].child.emit('close', 4);
  assert.equal(supervisor.stopped, true);
  assert.equal(launches[1].child.sent.at(-1), 'shutdown');
  launches[1].child.emit('close', 0);
  await delay(20);
  assert.equal(launches.length, 2);
});

test('ambas começam na mesma conta e só publicam após as duas confirmarem', (t) => {
  const { launches } = harness(t);
  assert.deepEqual(launches.map((l) => l.account.username), ['first', 'first']);
  launches[0].child.emit('message', { type: 'ready', username: 'first' });
  assert.deepEqual(launches[0].child.sent, []);
  launches[1].child.emit('message', { type: 'ready', username: 'first' });
  launches[1].child.emit('message', { type: 'ready', username: 'first' });
  for (const { child } of launches) assert.deepEqual(child.sent, ['resume']);
});

test('fecha o par anterior antes de trocar ambas, preservando os destinos', async (t) => {
  const { launches } = harness(t);
  launches[0].child.emit('close', 1);
  assert.deepEqual(launches[1].child.sent, ['shutdown']);
  await delay(20);
  assert.equal(launches.length, 2, 'Não pode lançar com o navegador anterior ativo.');
  launches[1].child.emit('close', 0);
  await until(() => launches.length === 4);
  assert.deepEqual(launches.slice(2).map((l) => [l.instance, l.account.username]),
    [['cazetv-1', 'second'], ['tntsportsbr-1', 'second']]);
  launches[2].child.emit('close', 0);
  launches[3].child.emit('close', 0);
  await until(() => launches.length === 6);
  assert.deepEqual(launches.slice(4).map((l) => l.account.username), ['first', 'first']);
});

test('duas saídas simultâneas provocam uma única troca', async (t) => {
  const { supervisor, launches } = harness(t);
  launches[0].child.emit('close', 2);
  launches[1].child.emit('close', 3);
  await until(() => launches.length === 4);
  assert.equal(supervisor.generation, 2);
  assert.equal(supervisor.accountIndex, 1);
});

test('três contas alternam as duas janelas e voltam à primeira sem sobreposição', async (t) => {
  const { launches } = harness(t, { accounts: [
    { username: 'first' }, { username: 'second' }, { username: 'third' },
  ] });
  for (const [cycle, expected] of ['first', 'second', 'third', 'first'].entries()) {
    const pair = launches.slice(cycle * 2, cycle * 2 + 2);
    assert.deepEqual(pair.map((item) => item.account.username), [expected, expected]);
    assert.deepEqual(pair.map((item) => item.instance), ['cazetv-1', 'tntsportsbr-1']);
    if (cycle === 3) break;
    pair[0].child.emit('close', 5);
    assert.equal(launches.length, (cycle + 1) * 2);
    pair[1].child.emit('close', 0);
    await until(() => launches.length === (cycle + 2) * 2);
  }
});

test('posts indisponíveis em uma janela trocam o par inteiro antes do próximo ciclo', async (t) => {
  const { supervisor, launches } = harness(t);
  for (const { child } of launches) child.emit('message', { type: 'ready', username: 'first' });
  launches[0].child.emit('message', { type: 'posts-unavailable' });
  launches[1].child.emit('message', { type: 'posts-unavailable' });
  assert.equal(supervisor.accountIndex, 1, 'Notificações simultâneas devem causar uma única troca.');
  for (const { child } of launches) assert.deepEqual(child.sent, ['resume', 'shutdown']);
  await delay(20);
  assert.equal(launches.length, 2, 'A conta seguinte deve aguardar o encerramento do par anterior.');
  launches[0].child.emit('close', 5);
  launches[1].child.emit('close', 0);
  await until(() => launches.length === 4);
  assert.deepEqual(launches.slice(2).map((l) => [l.instance, l.account.username]),
    [['cazetv-1', 'second'], ['tntsportsbr-1', 'second']]);
  launches[0].child.emit('message', { type: 'posts-unavailable' });
  assert.equal(supervisor.accountIndex, 1, 'Uma mensagem antiga não pode trocar o novo par.');
});

test('Ctrl+C durante a troca por posts indisponíveis impede a reabertura', async (t) => {
  const { supervisor, launches } = harness(t, { restartMs: 30 });
  for (const { child } of launches) child.emit('message', { type: 'ready', username: 'first' });
  launches[1].child.emit('message', { type: 'posts-unavailable' });
  for (const { child } of launches) child.emit('close', 0);
  supervisor.stop();
  await delay(50);
  assert.equal(launches.length, 2);
});

test('Ctrl+C cancela inclusive uma retomada já agendada', async (t) => {
  const { supervisor, launches } = harness(t, { restartMs: 30 });
  launches[0].child.emit('close', 4);
  launches[1].child.emit('close', 0);
  supervisor.stop();
  await delay(50);
  assert.equal(launches.length, 2);
});

test('encerra processo que não obedece ao shutdown antes de reabrir', async (t) => {
  const killed = [];
  const { launches } = harness(t, {
    stopTimeoutMs: 10,
    killTree: (child) => { killed.push(child); child.emit('close', null, 'SIGKILL'); },
  });
  launches[0].child.emit('close', 1);
  await until(() => launches.length === 4);
  assert.equal(killed.length, 1);
  assert.equal(killed[0], launches[1].child);
});

test('conta incorreta não recebe autorização para publicar', (t) => {
  const { supervisor, launches } = harness(t);
  launches[0].child.emit('message', { type: 'ready', username: 'wrong' });
  assert.equal(supervisor.rotating, true);
  for (const { child } of launches) assert.deepEqual(child.sent, ['shutdown']);
});

test('histórico conjunto conserva enviados e pendentes de ambas as contas', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-pair-test-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const primary = new Store(path.join(directory, 'primary.json'), { report: false });
  const secondary = new Store(path.join(directory, 'secondary.json'), { report: false });
  primary.markPending('already-sent', { author: 'a' });
  primary.markSent('already-sent');
  secondary.markPending('uncertain', { author: 'b' });
  secondary.markPending('already-sent', { author: 'a' });
  primary.importHistory(secondary.file);
  const switched = new Store(primary.file, { report: false });
  assert.equal(switched.markPending('already-sent', { author: 'a' }), false);
  assert.equal(switched.markPending('uncertain', { author: 'b' }), false);
  assert.equal(switched.data.comments['already-sent'].status, 'sent');
  assert.equal(switched.markPending('new', { author: 'c' }), true);
  assert.equal(primary.markPending('new', { author: 'c' }), false);
  assert.equal(secondary.has('uncertain'), true);
});
