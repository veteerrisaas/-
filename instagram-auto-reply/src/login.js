// Primeiro login: abre o navegador visível para você entrar manualmente (com 2FA).
// O script só observa se o cookie de sessão apareceu; nunca lê ou salva a senha.
import { IG_URL, isLoggedIn, openBrowser } from './browser.js';
import { log } from './logger.js';
import { sleep } from './human.js';
import path from 'node:path';
import { envSettings } from './config.js';

const TIMEOUT_MS = 5 * 60_000;

async function main() {
  const settings = envSettings();
  const { profilePath } = settings;
  const { context, page } = await openBrowser({ ...settings, headless: false });
  let closed = false;
  context.on('close', () => { closed = true; });

  try {
    if (process.argv.includes('--reauth')) {
      await context.clearCookies({ name: 'sessionid' });
      log.info('Sessão anterior removida; faça login novamente.');
    }
    await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });
    if (await isLoggedIn(context)) {
      log.info(`Você já está logado. Sessão salva em ${path.basename(profilePath)}/.`);
      return;
    }

    log.info('Faça login na janela do navegador (incluindo 2FA). Aguardando até 5 minutos...');
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (closed) throw new Error('O navegador foi fechado antes de concluir o login.');
      if (await isLoggedIn(context)) {
        log.info('Login detectado! Aguardando alguns segundos para a sessão ser gravada...');
        await sleep(5000);
        log.info('Pronto. As próximas execuções vão reaproveitar esta sessão.');
        return;
      }
      await sleep(2000);
    }
    throw new Error('Tempo esgotado esperando o login.');
  } finally {
    if (!closed) await context.close();
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
