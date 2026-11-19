import { CommentsUnavailableError, SendRejectedError } from './guard.js';

export function browserReadModes(username) {
  const user = username?.trim().replace(/^@/, '').toLowerCase();
  if (user === 'golsdodia.galo' || user === 'gabrieldastip' || user === 'gbrdastip' || user === 'gbrdastips' || user === 'gabrieldastips' || user === 'gabdastips' || user === 'correa.tipss') return ['desktop', 'mobile', 'iphone'];
  if (user === 'golsdodia.cabuloso') return ['desktop', 'mobile'];
  return [];
}

export const supportsBrowserReadFallback = (username) => browserReadModes(username).length > 0;
export const browserModeLabel = (mode) => ({ desktop: 'desktop', mobile: 'Android', iphone: 'iPhone' })[mode] || mode;
export const buildAccountModeSequence = (accounts, accountFirst = false) => accountFirst
  ? accounts.flatMap((account) => ['desktop', 'mobile', 'iphone'].map((browserMode) => ({ account, browserMode })))
  : ['desktop', 'iphone', 'mobile'].flatMap((browserMode) => accounts.map((account) => ({ account, browserMode })));
export const browserReadCycleLabel = (username) => {
  const modes = browserReadModes(username);
  return modes.length ? [...modes, modes[0]].map(browserModeLabel).join(' → ') : '';
};

export class RetryInBrowserMode extends Error {
  constructor(post, profile, browserMode, waitMs, cause) {
    super(`${cause instanceof SendRejectedError ? 'Envios recusados' : 'Falha de leitura'}; próxima interface: ${browserMode}: ${cause.message}`, { cause });
    this.post = post;
    this.profile = profile;
    this.browserMode = browserMode;
    this.waitMs = waitMs;
  }
}

/** Alterna nas contas autorizadas; falhas consecutivas aumentam a espera, sem recargas em loop. */
export class BrowserReadFallback {
  constructor() { this.failures = 0; }

  request(error, { enabled, username, browserMode, post, profile }) {
    const modes = browserReadModes(username);
    const currentIndex = modes.indexOf(browserMode);
    if (!enabled || currentIndex < 0
      || !(error instanceof CommentsUnavailableError || error instanceof SendRejectedError)) return;
    this.failures++;
    // A primeira troca é imediata; se as interfaces recusarem em sequência, aguarda 30s,
    // 60s, 120s... até 30 minutos. Uma leitura completa bem-sucedida zera a espera.
    const waitMs = this.failures === 1 ? 0
      : Math.min(30 * 60_000, 30_000 * 2 ** Math.min(6, this.failures - 2));
    throw new RetryInBrowserMode(post, profile, modes[(currentIndex + 1) % modes.length], waitMs, error);
  }

  succeeded() { this.failures = 0; }
}
