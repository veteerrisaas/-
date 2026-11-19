import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { parseRunWindow, runEndAt } from './run-window.js';
import { FOUR_PAGE_INSTANCES } from './instance-layout.js';

// Sobrescritas limitadas a este processo e seus filhos; o .env original é preservado.
const usernameFlag = process.argv.indexOf('--username');
const username = usernameFlag >= 0 ? process.argv[usernameFlag + 1] : 'gbrdastip';
if (!/^[a-z0-9._]{1,30}$/.test(username || '')) throw new Error('Usuário inválido.');
const loginProfileFlag = process.argv.indexOf('--login-profile');
const loginProfile = loginProfileFlag >= 0 ? process.argv[loginProfileFlag + 1] : username;
if (!/^[a-z0-9._]{1,30}$/.test(loginProfile || '')) throw new Error('Perfil de login inválido.');
const chromeLogin = process.argv.includes('--chrome-login');
const runWindow = parseRunWindow(process.argv);
process.env.IG_USERNAME = username;
process.env.IG_PRIMARY_PROFILE_PREFIX = `browser-profile-${username}`;
process.env.DRY_RUN = 'false';
const { ROOT, envSettings, loadConfig } = await import('./config.js');
const zeroRunDelays = process.argv.includes('--zero-action-delays') || loadConfig([]).zeroActionDelays;
if (zeroRunDelays) process.env.IG_RUN_ZERO_DELAYS = 'true';
const { openBrowser, isLoggedIn, IG_URL } = await import('./browser.js');
const args = ['--four', '--shared-history', '--mobile-fallback', '--sync-browser-modes', '--browser-mode', 'desktop',
  ...(zeroRunDelays ? ['--no-action-delays'] : [])];
if (zeroRunDelays) console.log(`Pausas de ação zeradas para @${username}; configuração das outras contas preservada.`);

if (!process.argv.includes('--check')) {
  let context;
  let cookies;
  try {
    if (chromeLogin) {
      context = await chromium.launchPersistentContext(path.join(ROOT, `browser-profile-chrome-manual-${loginProfile}`),
        { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 } });
    } else {
      ({ context } = await openBrowser({ headless: true, browserMode: 'desktop',
        profilePath: path.join(ROOT, `browser-profile-manual-${loginProfile}`) }));
    }
    if (!(await isLoggedIn(context))) throw new Error('Login ausente da conta nova. Faça login manual antes de iniciar.');
    const page = context.pages()[0];
    await page.goto(`${IG_URL}${username}/`, { waitUntil: 'domcontentloaded' });
    const editProfile = page.getByRole('link', { name: /^(Editar perfil|Edit profile)$/i })
      .or(page.getByRole('button', { name: /^(Editar perfil|Edit profile)$/i })).first();
    await editProfile.waitFor({ state: 'visible', timeout: 30000 });
    cookies = (await context.cookies()).filter(cookie => /(^|\.)instagram\.com$/i.test(cookie.domain.replace(/^\./, '')));
    console.log(`Sessão da @${username} confirmada. Preparando perfis separados.`);
  } finally { await context?.close().catch(() => {}); }

  // Só usa os perfis da conta selecionada; perfis de outras contas são preservados.
  for (const instance of FOUR_PAGE_INSTANCES) {
    try {
      ({ context } = await openBrowser({ ...envSettings(['--instance', instance]), headless: true, browserMode: 'desktop' }));
      await context.clearCookies();
      await context.addCookies(cookies);
    } finally { await context?.close().catch(() => {}); }
  }
}

// Reconfere após o login: uma preparação demorada não pode ultrapassar o horário.
const endAt = runEndAt(runWindow);
const child = fork(path.join(ROOT, 'src', 'service.js'),
  [...args, ...(process.argv.includes('--check') ? ['--check'] : [])], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true,
  });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log('Encerrando a árvore do serviço, incluindo navegadores e retomadas.');
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'inherit' });
    killer.on('error', error => { console.error(error.message); child.kill(); });
  } else child.kill('SIGTERM');
};
const timer = endAt !== null && !process.argv.includes('--check') ? setTimeout(() => {
  console.log('Horário limite atingido. Execução encerrada automaticamente, sem retomadas.');
  stop();
}, Math.max(0, endAt - Date.now())) : null;
if (timer) console.log(`Encerramento automático às ${
  new Date(endAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília), incluindo todas as retomadas.`);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = stopping ? 0 : code ?? 1; });
