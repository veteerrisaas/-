import path from 'node:path';
import { chromium, devices } from 'playwright';
import { ROOT } from './config.js';

const args = process.argv.slice(2);
const userFlag = args.indexOf('--username');
const username = userFlag >= 0 ? args[userFlag + 1] : null;
if (userFlag >= 0 && !/^[a-z0-9._]{1,30}$/.test(username || '')) throw new Error('Usuário inválido.');
const sequence = args.includes('--sequence');
// A conta nova usa um perfil próprio, sem alterar os perfis da automação.
const profile = path.join(ROOT, username ? `browser-profile-manual-${username}`
  : `browser-profile-new-account-iphone-${Date.now()}`);
const modes = sequence ? ['desktop', 'mobile', 'iphone'] : ['iphone'];
console.log(`Perfil salvo em: ${profile}`);
console.log('Somente uso manual; nenhuma automação de mensagens iniciada.');
if (sequence) console.log('Ordem: desktop → Android → iPhone. Feche a janela atual para avançar.');
for (const mode of modes) {
  const { defaultBrowserType, ...device } = devices[mode === 'iphone' ? 'iPhone 13' : 'Pixel 7'];
  const context = await chromium.launchPersistentContext(profile, {
    ...(mode === 'desktop' ? { viewport: { width: 1280, height: 900 } } : device), headless: false,
  });
  const closed = new Promise(resolve => context.once('close', resolve));
  const page = context.pages()[0] ?? await context.newPage();
  console.log(`Janela aberta: ${mode === 'mobile' ? 'Android' : mode}.`);
  try {
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Página aberta. Entre na conta nova e faça seus ajustes.');
  } catch (error) {
    console.error(`Navegador aberto; navegue manualmente se necessário: ${error.message}`);
  }
  await closed;
}
console.log('Sessão manual encerrada.');
