import fs from 'node:fs';
import { chromium, devices } from 'playwright';
import { PATHS, readText } from './config.js';
import { TEXT } from './selectors.js';
import { clearNavigationStatus, watchWhatHappened } from './guard.js';
import { configureClickDelay, humanClick } from './human.js';

export const IG_URL = 'https://www.instagram.com/';

/**
 * Abre o Chromium em modo desktop, Android ou iPhone conforme browserMode.
 * A sessão (cookies) fica salva ali; a senha nunca passa pelo script.
 * O Chromium trava a pasta do perfil, então duas execuções simultâneas não são possíveis.
 */
export async function openBrowser({ headless, profilePath = PATHS.profile, instance = null, fastNavigation = false, noActionDelays = false, browserMode: requestedMode, delays = {} }) {
  fs.mkdirSync(profilePath, { recursive: true });
  const browserMode = requestedMode ?? (fs.existsSync(PATHS.config)
    ? JSON.parse(readText(PATHS.config)).browserMode || 'mobile' : 'mobile');
  if (!['mobile', 'desktop', 'iphone'].includes(browserMode)) throw new Error('browserMode deve ser mobile, desktop ou iphone.');
  const device = browserMode === 'iphone' ? devices['iPhone 13'] : devices['Pixel 7'];
  const { defaultBrowserType, ...deviceOptions } = device;
  const context = await chromium.launchPersistentContext(profilePath, {
    ...(browserMode === 'desktop' ? { viewport: { width: 1280, height: 900 } } : deviceOptions),
    headless,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  configureClickDelay(page, delays.beforeClickMs);
  const originalGoto = page.goto.bind(page);
  page.goto = (...args) => { clearNavigationStatus(page); return originalGoto(...args); };
  page.setDefaultTimeout(15_000);
  if (instance) page.setDefaultNavigationTimeout(120_000);
  watchWhatHappened(context);
  return { context, page, browserMode };
}

export async function isLoggedIn(context) {
  const cookies = await context.cookies(IG_URL);
  return cookies.some((c) => c.name === 'sessionid' && c.value);
}

/** Fecha pop-ups como "Ativar notificações?" / "Salvar informações de login?". */
export async function dismissPopups(page) {
  for (let i = 0; i < 3; i++) {
    const btn = page.getByRole('button', { name: TEXT.notNow }).first();
    if (!(await btn.isVisible().catch(() => false))) return;
    await humanClick(page, btn).catch(() => {});
    await page.waitForTimeout(800);
  }
}
