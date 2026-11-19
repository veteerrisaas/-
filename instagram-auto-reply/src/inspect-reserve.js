import path from 'node:path';
import { ROOT } from './config.js';
import { openBrowser, isLoggedIn, dismissPopups } from './browser.js';

const { context, page } = await openBrowser({ headless: false, profilePath: path.join(ROOT, 'browser-profile-reserva') });
try {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (!(await isLoggedIn(context))) {
    console.log('SESSION_NOT_LOGGED_IN');
  } else {
    await dismissPopups(page);
    console.log(JSON.stringify(await page.locator('a[href]').evaluateAll(links => links.map(a => ({ href: a.getAttribute('href'), label: a.innerText, aria: a.getAttribute('aria-label') })).filter(a => /profile|perfil|imortal/i.test(a.href+' '+a.label+' '+a.aria))), null, 2));
    await page.goto('https://www.instagram.com/golsdodia.imortal/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    console.log((await page.locator('body').innerText()).slice(0, 10000));
    console.log(JSON.stringify(await page.locator('a[href]').evaluateAll(links => links.map(a => a.getAttribute('href')).filter(h => /\/p\/|\/reel\//.test(h))), null, 2));
    await page.screenshot({ path: path.join(ROOT, 'screenshots', 'reserva-inventario.png') });
  }
} finally { await context.close(); }
