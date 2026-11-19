import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { envSettings, loadConfig, ROOT, PATHS } from '../src/config.js';
import { accountFlags } from '../src/account-sessions.js';
import { FOUR_PAGE_INSTANCES } from '../src/instance-layout.js';

test('quatro destinos têm uma janela exclusiva por perfil, sem getv e preservando limites e sessões', () => {
  const previous = process.env.IG_USERNAME;
  process.env.IG_USERNAME = 'test_account';
  try {
    const cfg = loadConfig(['--instance', 'cazetv-1', '--single-worker']);
    assert.equal(cfg.targetProfile, 'ge.globo');
    assert.deepEqual(cfg.profiles.map(profile => profile.username), ['ge.globo']);
    assert.equal(cfg.profilePath, envSettings(['--instance', 'cazetv-1']).profilePath);
    const tnt = loadConfig(['--instance', 'tntsportsbr-1', '--single-worker']);
    assert.equal(tnt.targetProfile, 'tntsportsbr');
    assert.deepEqual(tnt.profiles.map(profile => profile.username), ['tntsportsbr']);
    const configs = FOUR_PAGE_INSTANCES.map(instance => loadConfig(['--instance', instance, '--single-worker']));
    assert.equal(configs.length, 4);
    assert.ok(configs.every(config => config.profiles.length === 1));
    assert.equal(new Set(configs.map(config => config.profilePath)).size, 4);
    const all = configs.flatMap(config => config.profiles);
    assert.equal(new Set(all.map(profile => profile.username)).size, 4);
    assert.deepEqual(all.map(profile => profile.username).sort(), ['tntsportsbr', 'ge.globo', 'espnbrasil', 'sportv'].sort());
    for (const username of ['ge.globo', 'espnbrasil', 'sportv']) {
      assert.equal(all.find(profile => profile.username === username).maxPerRun, 2);
    }
    assert.equal(loadConfig([]).profiles.length, 4);
  } finally {
    if (previous === undefined) delete process.env.IG_USERNAME;
    else process.env.IG_USERNAME = previous;
  }
});

test('conta nova usa perfis próprios sem alterar os caminhos das demais contas', () => {
  const previous = process.env.IG_PRIMARY_PROFILE_PREFIX;
  process.env.IG_PRIMARY_PROFILE_PREFIX = 'browser-profile-gbrdastip';
  try {
    const settings = envSettings(['--instance', 'cazetv-1']);
    assert.equal(settings.profilePath, path.join(ROOT, 'browser-profile-gbrdastip-cazetv-1'));
    assert.equal(envSettings(['--instance', 'cazetv-1', '--secondary-account']).profilePath,
      path.join(ROOT, 'browser-profile-account2-cazetv-1'));
    process.env.IG_PRIMARY_PROFILE_PREFIX = '../outro';
    assert.throws(() => envSettings([]), /IG_PRIMARY_PROFILE_PREFIX/);
  } finally {
    if (previous === undefined) delete process.env.IG_PRIMARY_PROFILE_PREFIX;
    else process.env.IG_PRIMARY_PROFILE_PREFIX = previous;
  }
});

test('fluxo Gab/Correa usa os três dispositivos de cada conta, começando no desktop', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const args = manifest.scripts['watch:2:gabriel-correa'].split(' ').slice(1);
  const output = execFileSync(process.execPath, [...args, '--check'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env,
      IG_USERNAME: 'gabrieldastip', IG_FOURTH_USERNAME: 'correa.tipss' },
  });
  assert.ok(output.includes('Fluxo conjunto: @gabrieldastip (desktop) → @gabrieldastip (Android) → @gabrieldastip (iPhone)'
    + ' → @correa.tipss (desktop) → @correa.tipss (Android) → @correa.tipss (iPhone) → repetir.'));
  assert.match(output, /Início: @gabrieldastip em desktop/);
  assert.match(output, /Retomada automática após encerramento: 15, 30, 60 e 120 minutos/);
  assert.doesNotMatch(output, /golsdodia|Envios liberados|Login salvo/);
});

test('correa usa perfis separados e histórico compartilhado sem selecionar outras contas', (t) => {
  const previous = process.env.IG_FOURTH_USERNAME;
  process.env.IG_FOURTH_USERNAME = 'correa.tipss';
  t.after(() => {
    if (previous === undefined) delete process.env.IG_FOURTH_USERNAME;
    else process.env.IG_FOURTH_USERNAME = previous;
  });
  assert.deepEqual(accountFlags(4), ['--fourth-account']);
  const settings = envSettings(['--instance', 'tntsportsbr-1', ...accountFlags(4)]);
  assert.equal(settings.username, 'correa.tipss');
  assert.equal(settings.accountNumber, 4);
  assert.equal(settings.usernameKey, 'IG_FOURTH_USERNAME');
  assert.equal(settings.profilePath, path.join(ROOT, 'browser-profile-account4-tntsportsbr-1'));
  assert.equal(settings.dataPath, path.join(ROOT, 'data', 'replied-correa.tipss.json'));
  assert.equal(envSettings(['--fourth-account', '--shared-history']).dataPath, PATHS.data);
  for (const flag of ['--third-account', '--secondary-account', '--reserve']) {
    assert.throws(() => envSettings(['--fourth-account', flag]), /não pode ser combinado/);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const args = manifest.scripts['watch:2:correa'].split(' ').slice(1);
  const output = execFileSync(process.execPath, [...args, '--check'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, IG_FOURTH_USERNAME: 'correa.tipss' },
  });
  assert.match(output, /cazetv-1: @correa\.tipss\. Interface inicial: desktop/);
  assert.match(output, /tntsportsbr-1: @correa\.tipss\. Interface inicial: desktop/);
  assert.match(output, /Conta fixa @correa\.tipss/);
  assert.match(output, /Retomada automática após encerramento: 15, 30, 60 e 120 minutos/);
  assert.doesNotMatch(output, /Envios liberados|Login salvo/);
});

test('modo dividido inicia Galo na cazetv e principal na TNT com troca individual nas recusas', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const [node, ...args] = manifest.scripts['watch:2:accounts:split'].split(' ');
  assert.equal(node, 'node');
  const output = execFileSync(process.execPath, [...args, '--check'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env,
      IG_USERNAME: 'gabrieldastip', IG_SECOND_USERNAME: 'golsdodia.galo' },
  });
  assert.match(output, /cazetv-1: @golsdodia\.galo\. Interface inicial: desktop\./);
  assert.match(output, /tntsportsbr-1: @gabrieldastip\. Interface inicial: desktop\./);
  assert.ok(args.includes('--shared-history'));
  assert.match(output, /alternância contínua desktop → Android → iPhone → desktop ativa para @gabrieldastip/);
  assert.match(output, /alternância contínua desktop → Android → iPhone → desktop ativa para @golsdodia\.galo/);
  assert.match(output, /Interfaces sincronizadas: ambas começam em desktop; trocam JUNTAS/);
  assert.match(output, /Contas iniciais: cazetv-1: @golsdodia\.galo; tntsportsbr-1: @gabrieldastip\./);
  assert.match(output, /Recusas de envio: troca somente a conta da janela afetada/);
  assert.doesNotMatch(output, /Troca conjunta|Fluxo conjunto|Login salvo|Envios liberados/);
});

test('interface secundária inválida ou fora do modo dividido é rejeitada antes de iniciar', () => {
  for (const args of [
    ['--two-accounts', '--secondary-browser-mode', 'invalid'],
    ['--two-accounts', '--secondary-browser-mode'],
    ['--two', '--secondary-browser-mode', 'mobile'],
    ['--two-accounts', '--sync-browser-modes', '--secondary-browser-mode', 'mobile'],
  ]) {
    assert.throws(() => execFileSync(process.execPath,
      [path.join(ROOT, 'src', 'watch-all.js'), ...args, '--check'], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
      }), (error) => error.status !== 0 && /--(?:secondary-)?browser-mode/.test(error.stderr));
  }
});

test('fluxo combinado intercala Galo e conta principal em desktop, iPhone e Android', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const [node, ...args] = manifest.scripts['watch:2:galo-first'].split(' ');
  assert.equal(node, 'node');
  const output = execFileSync(process.execPath, [...args, '--dry-run', '--check'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env,
      IG_USERNAME: 'gabrieldastip', IG_SECOND_USERNAME: 'golsdodia.galo',
      IG_THIRD_USERNAME: 'golsdodia.cabuloso' },
  });
  assert.match(output, /Troca conjunta: @golsdodia\.galo ↔ @gabrieldastip/);
  assert.ok(output.includes('Fluxo conjunto: @golsdodia.galo (desktop) → @gabrieldastip (desktop)'
    + ' → @golsdodia.galo (iPhone) → @gabrieldastip (iPhone)'
    + ' → @golsdodia.galo (Android) → @gabrieldastip (Android) → repetir.'));
  assert.match(output, /Início: @golsdodia\.galo em desktop/);
  assert.doesNotMatch(output, /cabuloso|Login salvo|Envios liberados/);
});

for (const [script, username, initialMode] of [
  ['watch:2:account2', 'golsdodia.galo', 'iphone'],
  ['watch:2:account3', 'golsdodia.cabuloso', 'desktop'],
]) {
  test(`${script} mantém ambas no mesmo modo e na mesma conta, sem iniciar envios no check`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const [node, ...args] = manifest.scripts[script].split(' ');
    assert.equal(node, 'node');
    const output = execFileSync(process.execPath, [...args, '--browser-mode', initialMode, '--check'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env,
        IG_SECOND_USERNAME: 'golsdodia.galo', IG_THIRD_USERNAME: 'golsdodia.cabuloso' },
    });
    assert.ok(output.includes(`cazetv-1: @${username}.`));
    assert.ok(output.includes(`tntsportsbr-1: @${username}.`));
    assert.ok(output.includes(`Interfaces sincronizadas: ambas começam em ${initialMode}; trocam JUNTAS`));
    assert.ok(output.includes(`Conta fixa @${username}.`));
    assert.doesNotMatch(output, /Troca conjunta|Login salvo|Envios liberados/);
  });
}

test('modo iPhone usa o mesmo perfil, conta e histórico da Galo; modo inválido é rejeitado', () => {
  const flags = ['--instance', 'tntsportsbr-1', '--secondary-account'];
  const original = envSettings(flags);
  const iphone = envSettings([...flags, '--browser-mode', 'iphone']);
  assert.equal(iphone.browserMode, 'iphone');
  assert.equal(iphone.accountNumber, 2);
  assert.equal(iphone.username, original.username);
  assert.equal(iphone.profilePath, original.profilePath);
  assert.equal(iphone.dataPath, original.dataPath);
  assert.equal(original.browserMode, undefined);
  assert.throws(() => envSettings([...flags, '--browser-mode']), /--browser-mode/);
  assert.throws(() => envSettings([...flags, '--browser-mode', 'unknown']), /--browser-mode/);
});

test('inicializador fixo da terceira conta seleciona essa conta nos dois destinos sem abrir navegadores', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'src', 'watch-all.js'),
    '--two', '--third-account', '--shared-history', '--prepare-account', '--check'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, IG_THIRD_USERNAME: 'third_account' },
  });
  assert.match(output, /cazetv-1: @third_account\./);
  assert.match(output, /tntsportsbr-1: @third_account\./);
  assert.doesNotMatch(output, /Troca conjunta|Login salvo/);
});

test('terceira conta tem sessões próprias e participa do histórico compartilhado', (t) => {
  const previous = process.env.IG_THIRD_USERNAME;
  process.env.IG_THIRD_USERNAME = 'third_account';
  t.after(() => {
    if (previous === undefined) delete process.env.IG_THIRD_USERNAME;
    else process.env.IG_THIRD_USERNAME = previous;
  });
  const caze = envSettings(['--instance', 'cazetv-1', '--third-account']);
  const tnt = envSettings(['--instance', 'tntsportsbr-1', '--third-account', '--shared-history']);
  assert.equal(caze.accountNumber, 3);
  assert.equal(caze.username, 'third_account');
  assert.equal(caze.usernameKey, 'IG_THIRD_USERNAME');
  assert.equal(caze.profilePath, path.join(ROOT, 'browser-profile-account3-cazetv-1'));
  assert.equal(tnt.profilePath, path.join(ROOT, 'browser-profile-account3-tntsportsbr-1'));
  assert.notEqual(caze.profilePath, envSettings(['--instance', 'cazetv-1', '--secondary-account']).profilePath);
  assert.equal(caze.dataPath, path.join(ROOT, 'data', 'replied-third_account.json'));
  assert.equal(tnt.dataPath, PATHS.data);
});

test('selecionar terceira conta não pode selecionar outra conta ao mesmo tempo', () => {
  assert.throws(() => envSettings(['--third-account', '--secondary-account']), /não pode ser combinado/);
  assert.throws(() => envSettings(['--third-account', '--reserve']), /não pode ser combinado/);
});
