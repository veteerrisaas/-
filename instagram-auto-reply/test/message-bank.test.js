import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MessageBank, normalizeMessage, composeMessage, loadMessageTemplates, fitsMessageRules } from '../src/message-bank.js';
import { loadConfig } from '../src/config.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-message-bank-'));
  const file = path.join(directory, 'messages.sqlite');
  const bank = new MessageBank(file);
  t.after(() => { bank.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, bank };
}

test('importa textos antigos e pendentes sem considerar menção, emojis ou pontuação como novidade', (t) => {
  const { directory, bank } = fixture(t);
  fs.writeFileSync(path.join(directory, 'replied.json'), JSON.stringify({ comments: {
    one: { status: 'sent', reply: '@pessoa ATENÇÃO! Veja os stories! 😎' },
    two: { status: 'pending', reply: '@outra Olhe meu perfil! ✅' },
  } }));
  bank.importHistory(directory);
  bank.importHistory(directory);
  assert.equal(bank.reserve(['atencao veja os stories 🔥', '@terceira OLHE MEU PERFIL']), null);
  assert.equal(bank.db.prepare('SELECT COUNT(*) AS n FROM used_messages').get().n, 2);
  assert.equal(bank.reserve(['Uma mensagem nova']), 'Uma mensagem nova');
});

test('reserva persiste entre conexões e esgotamento não recicla textos', (t) => {
  const { file, bank } = fixture(t);
  assert.equal(bank.reserve(['Texto exclusivo']), 'Texto exclusivo');
  const other = new MessageBank(file);
  try { assert.equal(other.reserve(['Texto exclusivo']), null); }
  finally { other.close(); }
  assert.equal(bank.reserve(['Texto exclusivo']), null);
});

test('todas as combinações atuais são distintas sem depender de emojis ou pontuação', () => {
  const templates = loadMessageTemplates(new URL('../message-templates.json', import.meta.url));
  const keys = new Set();
  for (let i = 0; i < templates.size; i++) {
    const text = composeMessage(templates, i);
    assert.ok(text.includes('stories'));
    assert.ok(text.includes('casa pra fazer a boa'));
    assert.ok(text.length <= 100);
    assert.match(text, /^\p{Lu}[\p{Lu}\p{M}]*!\s/u);
    assert.ok(fitsMessageRules(text, templates));
    keys.add(normalizeMessage(text));
  }
  assert.equal(keys.size, templates.size);
  assert.equal(templates.size, 50000);
});

test('modelos antigos longos ou sem palavra de impacto não passam pelas novas regras', (t) => {
  const { bank } = fixture(t);
  const templates = loadMessageTemplates(new URL('../message-templates.json', import.meta.url));
  const text = bank.reserve(['Pessoal, fica a dica! Olha meus stories!', `ATENÇÃO! ${'texto '.repeat(30)}`], templates);
  assert.ok(text);
  assert.ok(text.length <= 100);
  assert.match(text, /^\p{Lu}[\p{Lu}\p{M}]*!\s/u);
});

test('usa modelos configurados antes das combinações e para no esgotamento', (t) => {
  const { bank } = fixture(t);
  const templates = { slots: [['Olá'], ['pessoal,'], ['confere os stories.'], ['Até mais!']], size: 1, suffix: '' };
  assert.equal(bank.reserve(['Texto original'], templates), 'Texto original');
  assert.equal(bank.reserve(['Texto original'], templates), 'Olá pessoal, confere os stories. Até mais!');
  assert.equal(bank.reserve(['Texto original'], templates), null);
});

test('janelas concorrentes não reservam o mesmo texto', async (t) => {
  const { file, bank } = fixture(t);
  const moduleUrl = new URL('../src/message-bank.js', import.meta.url).href;
  const worker = `import { MessageBank } from ${JSON.stringify(moduleUrl)};
    const bank = new MessageBank(process.argv[1]);
    const slots = ['a', 'b', 'c', 'd'].map(prefix => [1,2,3,4].map(n => prefix+n));
    const messages = [];
    for (let i=0;i<20;i++) messages.push(bank.reserve(['original'], {slots, size:256}));
    bank.close(); console.log(JSON.stringify(messages));`;
  const batches = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, file], { windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  })));
  const messages = batches.flat();
  assert.equal(messages.length, 80);
  assert.ok(messages.every(Boolean));
  assert.equal(new Set(messages.map(normalizeMessage)).size, 80);
  assert.equal(bank.db.prepare('SELECT COUNT(*) AS n FROM used_messages').get().n, 80);
});

test('intervalo é compartilhado por conta, persiste e não bloqueia outras contas', (t) => {
  const { file, bank } = fixture(t);
  const other = new MessageBank(file);
  try {
    assert.equal(bank.claimSendSlot('conta', [8, 12], 1000, () => 0.5), 0);
    assert.equal(other.claimSendSlot('conta', [8, 12], 1001), 9999);
    assert.equal(other.claimSendSlot('conta', [8, 12], 11000, () => 0), 0);
    assert.equal(bank.claimSendSlot('conta', [8, 12], 11001), 7999);
    assert.equal(bank.claimSendSlot('outra', [8, 12], 11001), 0);
  } finally { other.close(); }
});

test('a conta configurada usa todas as pausas zeradas sem alterar outras contas nem limites', () => {
  const previous = process.env.IG_USERNAME;
  try {
    process.env.IG_USERNAME = 'gbrdastip';
    const cfg = loadConfig([]);
    assert.equal(cfg.zeroActionDelays, true);
    assert.ok(Object.values(cfg.delays).every(range => range[0] === 0 && range[1] === 0));
    assert.ok(cfg.messageBank);
    process.env.IG_USERNAME = 'another_account';
    const other = loadConfig([]);
    assert.equal(other.zeroActionDelays, false);
    assert.deepEqual(other.delays.betweenRepliesSec, [15, 20]);
    assert.deepEqual(other.limits, cfg.limits);
  } finally {
    if (previous === undefined) delete process.env.IG_USERNAME;
    else process.env.IG_USERNAME = previous;
  }
});

test('histórico inválido interrompe importação em vez de liberar repetição', (t) => {
  const { directory, bank } = fixture(t);
  fs.writeFileSync(path.join(directory, 'replied.json'), '{corrompido');
  assert.throws(() => bank.importHistory(directory));
});

test('intervalo zero não espera a vez de outra janela nem uma reserva de intervalo anterior', t => {
  const { file, bank } = fixture(t);
  const other = new MessageBank(file);
  try {
    assert.equal(bank.claimSendSlot('gbrdastip', [15, 20], 1000, () => 0), 0);
    assert.equal(other.claimSendSlot('gbrdastip', [0, 0], 1001), 0);
    assert.equal(bank.claimSendSlot('gbrdastip', [0, 0], 1001), 0);
    assert.equal(bank.reserve(['Texto compartilhado']), 'Texto compartilhado');
    assert.equal(other.reserve(['Texto compartilhado']), null);
  } finally { other.close(); }
});

test('pausas zeradas por execução não modificam a configuração persistente nem os filtros', () => {
  const previousUser = process.env.IG_USERNAME;
  const previousRun = process.env.IG_RUN_ZERO_DELAYS;
  process.env.IG_USERNAME = 'test_account';
  try {
    delete process.env.IG_RUN_ZERO_DELAYS;
    const normal = loadConfig([]);
    process.env.IG_RUN_ZERO_DELAYS = 'true';
    const temporary = loadConfig(['--no-action-delays']);
    assert.ok(Object.values(temporary.delays).every(range => range[0] === 0 && range[1] === 0));
    assert.deepEqual(temporary.messageBank, normal.messageBank);
    assert.deepEqual(temporary.limits, normal.limits);
    delete process.env.IG_RUN_ZERO_DELAYS;
    assert.deepEqual(loadConfig([]).delays, normal.delays);
  } finally {
    if (previousUser === undefined) delete process.env.IG_USERNAME;
    else process.env.IG_USERNAME = previousUser;
    if (previousRun === undefined) delete process.env.IG_RUN_ZERO_DELAYS;
    else process.env.IG_RUN_ZERO_DELAYS = previousRun;
  }
});

test('--no-action-delays preserva os 15 a 20 segundos entre mensagens', () => {
  const previous = process.env.IG_USERNAME;
  process.env.IG_USERNAME = 'test_account';
  try {
    const cfg = loadConfig(['--no-action-delays']);
    assert.deepEqual(cfg.delays.betweenRepliesSec, [15, 20]);
    assert.deepEqual(cfg.delays.betweenPostsSec, [0, 0]);
    assert.ok(cfg.messageBank);
  } finally {
    if (previous === undefined) delete process.env.IG_USERNAME;
    else process.env.IG_USERNAME = previous;
  }
});
