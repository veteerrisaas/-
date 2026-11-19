import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import path from 'node:path';
import { ServiceRestart, RESTART_DELAYS_MS } from '../src/service-restart.js';

function harness(options = {}) {
  const children = [], jobs = new Set(), logs = [];
  const service = new ServiceRestart({
    launch: () => {
      const child = new EventEmitter();
      child.connected = true;
      child.sent = [];
      child.send = (message) => child.sent.push(message);
      children.push(child);
      return child;
    },
    log: (message) => logs.push(message),
    schedule: (callback, ms) => { const job = { callback, ms }; jobs.add(job); return job; },
    cancel: (job) => jobs.delete(job),
    now: () => Date.UTC(2026, 9, 24, 12),
    ...options,
  });
  const run = (job) => { jobs.delete(job); job.callback(); };
  return { service, children, jobs, logs, run };
}

test('encerramentos usam 15, 30, 60, 120 e repetem 120 minutos, sem sobrepor processos', () => {
  const { service, children, jobs, run, logs } = harness();
  service.start();
  for (const minutes of [15, 30, 60, 120, 120]) {
    const count = children.length;
    service.start();
    assert.equal(children.length, count);
    const child = children.at(-1);
    child.emit('error', new Error('falha'));
    assert.equal(jobs.size, 0, 'Só retoma após o processo antigo fechar.');
    child.emit('close', 0);
    child.emit('close', 1);
    assert.equal(jobs.size, 1);
    const job = [...jobs][0];
    assert.equal(job.ms, minutes * 60_000);
    service.start();
    assert.equal(children.length, count, 'A espera não pode ser ignorada.');
    run(job);
    assert.equal(children.length, count + 1);
  }
  assert.ok(logs.some((line) => line.includes('24/10/2026, 09:15:00')));
});

test('parada manual cancela espera e impede retomada mesmo com callback antigo', () => {
  const { service, children, jobs, run } = harness();
  service.start();
  children[0].emit('close', 1);
  const job = [...jobs][0];
  service.stop();
  assert.equal(jobs.size, 0);
  run(job);
  service.start();
  assert.equal(children.length, 1);
});

test('parada manual fecha o acompanhamento e só força encerramento após o prazo', () => {
  const killed = [];
  const { service, children, jobs } = harness({ killTree: (child) => killed.push(child) });
  service.start();
  service.stop();
  service.stop();
  assert.deepEqual(children[0].sent, ['shutdown']);
  assert.equal(killed.length, 0);
  assert.equal(jobs.size, 1);
  children[0].emit('close', 0);
  assert.equal(jobs.size, 0);
  assert.equal(service.failures, 0);
});

test('erro síncrono ao iniciar também agenda a próxima tentativa', () => {
  const { service, jobs } = harness({ launch: () => { throw new Error('spawn falhou'); } });
  service.start();
  assert.equal([...jobs][0].ms, RESTART_DELAYS_MS[0]);
  service.stop();
});

test('falha de validação com IPC encerra antes de abrir navegadores', async () => {
  const args = ['--two-accounts', '--shared-history', '--sync-browser-modes', '--instance-account-failover',
    '--mobile-fallback', '--browser-mode', 'desktop'];
  const entry = path.resolve('src/watch-all.js');
  // Usuários iguais falham na validação, antes de abrir qualquer navegador.
  const child = fork(entry, args, { execArgv: [], windowsHide: true,
    env: { ...process.env, IG_USERNAME: 'golsdodia.galo', IG_SECOND_USERNAME: 'golsdodia.galo' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Processo permaneceu aberto pelo IPC.')); }, 5000);
    child.on('error', reject);
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.notEqual(exit, 0);
  assert.match(output, /usuários diferentes/);
});
