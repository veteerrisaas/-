import { fork } from 'node:child_process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, loadConfig, envSettings } from './config.js';
import { PairSupervisor } from './pair-supervisor.js';
import { synchronizeAccountSessions, accountFlags } from './account-sessions.js';
import { Store } from './store.js';
import { FIVE_PAGE_INSTANCES, FOUR_PAGE_INSTANCES } from './instance-layout.js';
import { supportsBrowserReadFallback, browserReadCycleLabel, browserReadModes, browserModeLabel, buildAccountModeSequence } from './mobile-fallback.js';

const requestedMode = envSettings().browserMode;
const browserModeArgs = requestedMode ? ['--browser-mode', requestedMode] : [];
const secondaryModeFlag = process.argv.indexOf('--secondary-browser-mode');
const secondaryBrowserMode = secondaryModeFlag < 0 ? null
  : envSettings(['--browser-mode', process.argv[secondaryModeFlag + 1]]).browserMode;

const gabrielCorreaFlow = process.argv.includes('--gabriel-correa-failover');
const accountModeFailover = process.argv.includes('--account-mode-failover') || gabrielCorreaFlow;
if (gabrielCorreaFlow && ['--account-mode-failover', '--account-failover', '--two-accounts', '--secondary-account', '--third-account', '--fourth-account'].some((flag) => process.argv.includes(flag))) {
  throw new Error('--gabriel-correa-failover seleciona somente a conta principal e a quarta conta.');
}
const synchronized = process.argv.includes('--account-failover') || accountModeFailover;
const modeSynchronized = process.argv.includes('--sync-browser-modes') || accountModeFailover;
const splitModeSynchronized = modeSynchronized && !synchronized && process.argv.includes('--two-accounts');
const instanceAccountFailover = process.argv.includes('--instance-account-failover');
if (instanceAccountFailover && !splitModeSynchronized) {
  throw new Error('--instance-account-failover exige --two-accounts e --sync-browser-modes.');
}
if (secondaryBrowserMode && (!process.argv.includes('--two-accounts') || synchronized || modeSynchronized)) {
  throw new Error('--secondary-browser-mode exige --two-accounts com interfaces independentes.');
}
if (synchronized && modeSynchronized && !accountModeFailover) throw new Error('Para combinar as trocas de conta e interface, use --account-mode-failover.');
// --caze-only: duas janelas na cazetv, cada uma com metade dos posts (sem a TNT).
const cazeOnly = process.argv.includes('--caze-only');
const fivePages = process.argv.includes('--five');
const fourPages = process.argv.includes('--four');
if ((fivePages || fourPages) && (cazeOnly || synchronized || process.argv.includes('--two-accounts') || (fivePages && fourPages))) {
  throw new Error('--four/--five usam uma conta por layout; não combine layouts nem divisão ou troca de contas.');
}
if (cazeOnly && (synchronized || process.argv.includes('--two-accounts'))) {
  throw new Error('--caze-only usa uma única conta; não combine com --two-accounts ou --account-failover.');
}
const instances = fourPages ? FOUR_PAGE_INSTANCES : fivePages ? FIVE_PAGE_INSTANCES : cazeOnly ? ['cazetv-1', 'cazetv-2']
  : synchronized || modeSynchronized || process.argv.includes('--two') || process.argv.includes('--two-accounts')
  ? ['cazetv-1', 'tntsportsbr-1'] : process.argv.includes('--three')
  ? ['cazetv-1', 'cazetv-2', 'tntsportsbr-1']
  : ['cazetv-1', 'cazetv-2', 'tntsportsbr-1', 'tntsportsbr-2'];
// No modo dividido, a Galo (conta 2) fica na cazetv e a principal na TNT.
const secondaryInstancePrefix = 'cazetv-';
const soleWorker = (instance) => instances.filter((name) => name.slice(0, -2) === instance.slice(0, -2)).length === 1;
const argsFor = (instance) => ['--watch', '--instance', instance,
  ...(secondaryBrowserMode && instance.startsWith(secondaryInstancePrefix)
    ? ['--browser-mode', secondaryBrowserMode] : browserModeArgs),
  ...(process.argv.includes('--secondary-account')
    || (process.argv.includes('--two-accounts') && instance.startsWith(secondaryInstancePrefix)) ? ['--secondary-account'] : []),
  ...(process.argv.includes('--third-account') ? ['--third-account'] : []),
  ...(process.argv.includes('--fourth-account') ? ['--fourth-account'] : []),
  ...(process.argv.includes('--shared-history') ? ['--shared-history'] : []),
  ...(process.argv.includes('--no-action-delays') ? ['--no-action-delays'] : []),
  ...(process.argv.includes('--fast-navigation') ? ['--fast-navigation'] : []),
  ...(process.argv.includes('--mobile-fallback') ? ['--mobile-fallback'] : []),
  ...(process.argv.includes('--dry-run') ? ['--dry-run'] : []),
  ...(soleWorker(instance) ? ['--single-worker'] : [])];
// Valida todas antes de iniciar qualquer navegador.
for (const instance of instances) loadConfig(argsFor(instance));
const pairArgs = (instance, number, mode = requestedMode) => ['--watch', '--instance', instance,
  ...(soleWorker(instance) ? ['--single-worker'] : []),
  ...(mode ? ['--browser-mode', mode] : []),
  '--managed-pair', '--shared-history', ...accountFlags(number),
  ...(instanceAccountFailover ? ['--instance-account-failover'] : []),
  ...(modeSynchronized ? ['--sync-browser-modes'] : []),
  ...(process.argv.includes('--mobile-fallback') ? ['--mobile-fallback'] : []),
  ...(process.argv.includes('--dry-run') ? ['--dry-run'] : []),
  ...(process.argv.includes('--no-action-delays') ? ['--no-action-delays'] : [])];
const fixedConfigs = modeSynchronized && !synchronized ? instances.map((instance) => loadConfig(argsFor(instance))) : [];
if (fixedConfigs.length && !splitModeSynchronized && (new Set(fixedConfigs.map((cfg) => cfg.username)).size !== 1
  || new Set(fixedConfigs.map((cfg) => cfg.accountNumber)).size !== 1)) {
  throw new Error('A sincronização de interface exige a mesma conta nas duas janelas.');
}
if (fixedConfigs.some((cfg) => !browserReadModes(cfg.username).includes(cfg.browserMode)
  || cfg.browserMode !== fixedConfigs[0].browserMode
  || browserReadModes(cfg.username).join(',') !== browserReadModes(fixedConfigs[0].username).join(','))) {
  throw new Error('Conta ou interface inicial não habilitada para alternância sincronizada.');
}
const accounts = synchronized ? (gabrielCorreaFlow ? [1, 4] : accountModeFailover ? [2, 1]
  : [1, 2, ...(process.env.IG_THIRD_USERNAME?.trim() ? [3] : [])]).map((number) => {
  const configs = instances.map((instance) => loadConfig(pairArgs(instance, number)));
  return { number, username: configs[0].username };
}) : modeSynchronized ? (splitModeSynchronized ? fixedConfigs : fixedConfigs.slice(0, 1))
  .map((cfg) => ({ number: cfg.accountNumber, username: cfg.username })) : [];
const instanceAccounts = splitModeSynchronized
  ? Object.fromEntries(instances.map((instance, index) => [instance, accounts[index]])) : null;
if ((synchronized || splitModeSynchronized) && new Set(accounts.map((account) => account.username)).size !== accounts.length) {
  throw new Error('As contas configuradas no .env devem ter usuários diferentes para alternar.');
}
const initialBrowserMode = modeSynchronized
  ? accountModeFailover ? requestedMode || 'desktop' : fixedConfigs[0].browserMode : null;
const accountModeSequence = accountModeFailover ? buildAccountModeSequence(accounts, gabrielCorreaFlow) : [];
const accountModeFlowLabel = accountModeSequence.map(({ account, browserMode }) =>
  `@${account.username} (${browserModeLabel(browserMode)})`).join(' → ');
if (accountModeFailover && accountModeSequence.some(({ account, browserMode }) =>
  !browserReadModes(account.username).includes(browserMode))) {
  throw new Error('As duas contas precisam estar habilitadas para desktop, Android e iPhone.');
}
if (accountModeFailover && (process.argv.includes('--start-secondary') || process.argv.includes('--start-third'))) {
  throw new Error('O fluxo combinado define a conta inicial; não use --start-secondary ou --start-third.');
}
if (gabrielCorreaFlow && initialBrowserMode !== 'desktop') throw new Error('O fluxo gabrieldastip/correa começa no desktop.');
if (process.argv.includes('--start-secondary') && process.argv.includes('--start-third')) {
  throw new Error('Escolha somente uma conta inicial: --start-secondary ou --start-third.');
}
if (synchronized && !accountModeFailover) {
  const startNumber = process.argv.includes('--start-third') ? 3 : process.argv.includes('--start-secondary') ? 2 : 1;
  const startIndex = accounts.findIndex((account) => account.number === startNumber);
  if (startIndex < 0) throw new Error('Defina IG_THIRD_USERNAME no .env antes de iniciar com --start-third.');
  accounts.push(...accounts.splice(0, startIndex));
}

if (process.argv.includes('--check')) {
  console.log(`Configuração validada: ${instances.join(', ')}. Nenhuma execução iniciada.`);
  if (!synchronized) {
    for (const instance of instances) {
      const cfg = loadConfig(argsFor(instance));
      console.log(`${instance}: @${cfg.username}. Interface inicial: ${browserModeLabel(cfg.browserMode)}.`);
      console.log(`${instance}: destinos ${cfg.profiles.map(profile => `@${profile.username}`).join(', ')}.`);
    }
    if (process.argv.includes('--mobile-fallback')) {
      for (const instance of instances) {
        const cfg = loadConfig(argsFor(instance));
        console.log(`${instance}: alternância contínua ${browserReadCycleLabel(cfg.username)} ${supportsBrowserReadFallback(cfg.username) ? 'ativa' : 'desativada'} para @${cfg.username}.`);
      }
    }
  }
  if (synchronized) console.log(`Troca conjunta: ${accounts.map((a) => `@${a.username}`).join(' ↔ ')}; histórico compartilhado; Ctrl+C encerra o acompanhamento.`);
  if (modeSynchronized && !accountModeFailover) console.log(`Interfaces sincronizadas: ${instances.length === 2 ? 'ambas' : `${instances.length} janelas`} começam em ${initialBrowserMode}; trocam JUNTAS e aguardam ${instances.length === 2 ? 'as duas' : `as ${instances.length}`} confirmações. ${splitModeSynchronized
    ? `Contas ${instanceAccountFailover ? 'iniciais' : 'fixas'}: ${instances.map((instance) => `${instance}: @${instanceAccounts[instance].username}`).join('; ')}.`
    : `Conta fixa @${accounts[0].username}.`}`);
  if (accountModeFailover) console.log(`Fluxo conjunto: ${accountModeFlowLabel} → repetir. Início: @${accounts[0].username} em ${initialBrowserMode}.`);
  if (instanceAccountFailover) console.log('Recusas de envio: troca somente a conta da janela afetada, usando a outra conta ativa. Erros de leitura: desktop → Android → iPhone juntos.');
} else if (synchronized || modeSynchronized) {
  let supervisor;
  let interrupted = false;
  const stop = () => { interrupted = true; supervisor?.stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.send) {
    process.on('message', (message) => { if (message === 'shutdown') stop(); });
    process.on('disconnect', stop);
    process.channel?.unref();
  }
  try {
    if (accountModeFailover) console.log(`Fluxo conjunto: ${accountModeFlowLabel} → repetir.`);
    // No modo dividido, cada conta tem como origem a janela em que trabalha.
    const workingInstance = (number) => instances.find((instance) => instanceAccounts[instance].number === number);
    if (gabrielCorreaFlow) {
      for (const account of accounts) {
        if (interrupted) break;
        try { await synchronizeAccountSessions(() => interrupted, [account.number]); }
        catch (error) { console.error(`Sessão de @${account.username} não preparada: ${error.message}. O login será conferido antes de enviar.`); }
      }
    } else await synchronizeAccountSessions(() => interrupted, accounts.map((account) => account.number),
      splitModeSynchronized ? { loginInstance: workingInstance }
        : fivePages || fourPages ? { loginInstance: () => instances[0], targetInstances: instances }
        : cazeOnly ? { targetInstances: instances } : {});
    const sharedHistory = loadConfig(pairArgs(instances[0], accounts[0].number)).dataPath;
    const store = new Store(sharedHistory);
    for (const number of modeSynchronized ? [1, 2, 3, 4] : accounts.map((account) => account.number).filter((number) => number > 1)) {
      const source = envSettings(['--instance', 'tntsportsbr-1', ...accountFlags(number)]);
      if (source.username) store.importHistory(source.dataPath);
    }
    supervisor = new PairSupervisor({
      accounts, instances, instanceAccounts,
      accountFailover: instanceAccountFailover,
      syncBrowserModes: modeSynchronized,
      alternateAccountsByMode: accountModeFailover,
      accountFirst: gabrielCorreaFlow,
      browserMode: initialBrowserMode,
      launch: (instance, account, session) => fork(path.join(ROOT, 'src', 'index.js'),
        [...pairArgs(instance, account.number, modeSynchronized ? session.browserMode : requestedMode),
          ...(session.sessionFromParent ? ['--session-from-parent'] : [])], {
        cwd: ROOT, env: { ...process.env, IG_INSTANCE_LABEL: instance },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      }),
      killTree: (child) => {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill('SIGKILL');
      },
    });
    if (!interrupted) supervisor.start();
  } catch (err) {
    console.error(`Não foi possível preparar o par: ${err.message}`);
    process.exitCode = 1;
  }
} else {
  const children = new Set();
  let stopping = false;
  let exitCode = 0;
  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    console.log(`Encerrando as ${instances.length} instâncias...`);
    for (const child of children) {
      if (child.connected) child.send('shutdown', () => {});
    }
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);
  let prepared = true;
  try {
    if (process.argv.includes('--prepare-account')) {
      const numbers = [...new Set(instances.map((instance) => loadConfig(argsFor(instance)).accountNumber))];
      if (numbers.length !== 1) throw new Error('A preparação fixa exige a mesma conta nas duas janelas.');
      await synchronizeAccountSessions(() => stopping, numbers);
    }
    if (!stopping && process.argv.includes('--shared-history')) {
      const store = new Store(loadConfig(argsFor(instances[0])).dataPath);
      for (const number of [1, 2, 3, 4]) {
        const source = envSettings(['--instance', 'tntsportsbr-1', ...accountFlags(number)]);
        if (source.username) store.importHistory(source.dataPath);
      }
      console.log('Históricos existentes reunidos; enviados e pendentes não serão repetidos.');
    }
  } catch (err) {
    console.error(`Não foi possível preparar as janelas: ${err.message}`);
    process.exitCode = 1;
    prepared = false;
  }
  for (const instance of prepared && !stopping ? instances : []) {
    const child = fork(path.join(ROOT, 'src', 'index.js'), argsFor(instance), {
      cwd: ROOT,
      env: { ...process.env, IG_INSTANCE_LABEL: instance },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    children.add(child);
    child.on('message', (message) => {
      if (message !== 'rate-limit') return;
      console.error(`[${instance}] HTTP 429: encerrando todas as instâncias sem reiniciar.`);
      exitCode = 2;
      stopAll();
    });
    child.on('error', (err) => {
      console.error(`[${instance}] ${err.message}`);
      exitCode = 1;
      stopAll();
    });
    child.on('exit', (code, signal) => {
      children.delete(child);
      console.log(`[${instance}] encerrada (${signal || code}).`);
      if (!stopping) {
        exitCode = code || 1;
        stopAll();
      }
      if (!children.size) process.exitCode = exitCode;
    });
  }
}
