import { openBrowser, isLoggedIn } from './browser.js';
import { envSettings } from './config.js';

export const defaultLoginInstance = (accountNumber) => accountNumber > 1 ? 'tntsportsbr-1' : 'cazetv-1';
export const accountFlags = (number) => number === 4 ? ['--fourth-account'] : number === 3 ? ['--third-account'] : number === 2 ? ['--secondary-account'] : [];

// Por padrão os logins ficam na cazetv (principal) e na TNT (demais contas).
// No modo dividido, a origem é a janela onde a conta trabalha, para que a cópia
// parada no outro perfil nunca sobrescreva a sessão em uso.
// Copia apenas cookies em memória, com os navegadores de trabalho fechados.
export async function synchronizeAccountSessions(shouldStop = () => false,
  accountNumbers = [1, 2, ...(process.env.IG_THIRD_USERNAME?.trim() ? [3] : [])],
  { loginInstance = defaultLoginInstance, targetInstances = null } = {}) {
  const sessions = [];
  for (const accountNumber of accountNumbers) {
    if (shouldStop()) return;
    const sourceInstance = loginInstance(accountNumber);
    const flags = accountFlags(accountNumber);
    const source = envSettings(['--instance', sourceInstance, ...flags]);
    const targets = (targetInstances || [sourceInstance.startsWith('cazetv-') ? 'tntsportsbr-1' : 'cazetv-1'])
      .filter((instance) => instance !== sourceInstance)
      .map((instance) => envSettings(['--instance', instance, ...flags]));
    let cookies;
    let context;
    try {
      ({ context } = await openBrowser({ ...source, headless: true }));
      if (!(await isLoggedIn(context))) {
        throw new Error(`Login ausente de @${source.username}. Use npm run login -- --instance ${sourceInstance}${flags.length ? ` ${flags[0]}` : ''}, faça login e aguarde o encerramento da janela.`);
      }
      cookies = (await context.cookies()).filter((cookie) => /(^|\.)instagram\.com$/i.test(cookie.domain.replace(/^\./, '')));
    } finally {
      await context?.close().catch(() => {});
    }
    sessions.push({ source, targets, cookies });
  }
  const userIds = sessions.map(({ cookies }) => cookies.find((c) => c.name === 'ds_user_id')?.value).filter(Boolean);
  if (new Set(userIds).size !== userIds.length) {
    throw new Error('Existem logins salvos de contas diferentes que pertencem ao mesmo usuário. Confira cada login antes de iniciar.');
  }
  for (const { source, targets, cookies } of sessions) {
    for (const target of targets) {
      if (shouldStop()) return;
      let context;
      try {
        ({ context } = await openBrowser({ ...target, headless: true }));
        await context.clearCookies();
        await context.addCookies(cookies);
      } finally {
        await context?.close().catch(() => {});
      }
    }
    console.log(`Login salvo de @${source.username} preparado para ${targets.length + 1} janelas.`);
  }
}
