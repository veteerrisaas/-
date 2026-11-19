import { IG_URL, openBrowser } from './browser.js';
import { envSettings } from './config.js';

async function main() {
  const settings = envSettings();
  const { context, page, browserMode } = await openBrowser({ ...settings, headless: false });
  const closed = new Promise((resolve) => context.once('close', resolve));
  try {
    await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });
    console.log(`Instagram aberto em modo ${browserMode}. Ajuste ou faça login manualmente. Feche a janela quando terminar.`);
    await closed;
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
