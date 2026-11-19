import path from 'node:path';
import { ROOT } from './config.js';
import { openBrowser, IG_URL, isLoggedIn } from './browser.js';
const username = process.argv[2];
if (!/^[a-z0-9._]{1,30}$/.test(username || '')) throw new Error('Usuário inválido.');
const { context, page } = await openBrowser({ headless: true, browserMode: 'desktop',
  profilePath: path.join(ROOT, `browser-profile-manual-${username}`) });
try {
  console.log(`Sessão autenticada: ${await isLoggedIn(context)}`);
  await page.goto(`${IG_URL}${username}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log(`Página: ${page.url()}`);
  console.log((await page.locator('body').innerText()).slice(0, 3500));
  console.log('Links de perfil:', await page.locator('a').evaluateAll(links => links
    .filter(link => /perfil|profile/i.test(link.innerText || link.getAttribute('aria-label') || ''))
    .map(link => ({ label: link.innerText || link.getAttribute('aria-label'), href: link.getAttribute('href') }))));
  await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log('Perfil no menu da sessão:', await page.locator('a').evaluateAll(links => links
    .filter(link => /^(profile|perfil)$/i.test((link.innerText || '').trim())
      || [...link.querySelectorAll('[aria-label]')].some(el => /^(profile|perfil)$/i.test(el.getAttribute('aria-label'))))
    .map(link => link.getAttribute('href'))));
  await page.goto(`${IG_URL}accounts/edit/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log('Página de edição:', page.url());
  console.log('Cabeçalho da edição:', (await page.locator('body').innerText()).slice(0, 900));
} finally { await context.close(); }
