import { BLOCK_PATTERNS, BLOCK_URL, TEXT } from './selectors.js';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { log } from './logger.js';

export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
  }
}

export class CommentsUnavailableError extends Error {}
/** O Instagram recusou envios seguidos nesta interface (ex.: "Não foi possível comentar"). */
export class SendRejectedError extends Error {}
export class ReplyReadLimitedError extends CommentsUnavailableError {}
export class PageUnavailableError extends Error {}
const navigationStatus = new WeakMap();
export const getNavigationStatus = (page) => navigationStatus.get(page) || 0;
export const clearNavigationStatus = (page) => navigationStatus.delete(page);

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** HTTP 429 também pode aparecer na navegação, sem aviso no HTML. */
export function monitorRateLimits(context, onLimit) {
  const onResponse = async (response) => {
    let hostname;
    try { hostname = new URL(response.url()).hostname; } catch { return; }
    if (!/(^|\.)instagram\.com$/i.test(hostname)) return;
    const request = response.request();
    let visiblePage = false;
    if (request.isNavigationRequest() && request.resourceType() === 'document') {
      try {
        const frame = request.frame();
        if (!frame.parentFrame()) {
          navigationStatus.set(frame.page(), response.status());
          visiblePage = true;
        }
      } catch {
        // Uma navegação pode responder antes de criar o frame. Ainda confere HTTP 429 abaixo.
      }
    }
    if (response.status() !== 429) return;
    const headers = await response.allHeaders().catch(() => response.headers());
    onLimit({ visiblePage, path: new URL(response.url()).pathname,
      retryAfter: headers['retry-after'] || null,
      waitMs: retryAfterMs(headers['retry-after']) });
  };
  context.on('response', onResponse);
  return () => context.off('response', onResponse);
}

function scanPage(page) {
  return page.evaluate((sources) => {
    const patterns = sources.map((s) => new RegExp(s, 'i'));
    const loadingError = /(?:não é possível|n[aã]o foi poss[ií]vel|can['’]?t|couldn['’]?t|unable to)\s+(?:carregar\s+os\s+coment[aá]rios|load\s+comments)/i;
    const retryLater = /^(?:tente novamente mais tarde|try again later)[.!]?$/i;
    let unavailable = false;
    let blocked = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (!text || text.length > 400) continue;
      const el = walker.currentNode.parentElement;
      if (!el || el.closest('[data-ar-comment], textarea, [contenteditable="true"], script, style')) continue;
      // Ignora texto escrito por outras pessoas nos comentários.
      const li = el.closest('li');
      if (li && li.querySelector('a[href*="/c/"] time')) continue;
      if (!el.getClientRects().length) continue;
      if (/^(?:HTTP\s+ERROR\s*429|429\s+Too Many Requests)$/i.test(text)) {
        return { pageError: 429 };
      }
      if (loadingError.test(text)) unavailable = true;
      if (patterns.some((p) => p.test(text))) {
        let loadingContext = false;
        if (retryLater.test(text)) {
          for (let parent = el.parentElement, depth = 0;
            parent && parent !== document.body && depth < 3;
            parent = parent.parentElement, depth++) {
            if (loadingError.test(parent.innerText || '')) { loadingContext = true; break; }
          }
        }
        if (!loadingContext) blocked = text;
      }
    }
    if (document.querySelector('iframe[src*="captcha" i], iframe[title*="captcha" i]')) {
      return { blocked: 'captcha (iframe)' };
    }
    return { blocked, unavailable };
  }, BLOCK_PATTERNS.map((p) => p.source));
}

const dumpedDialogs = new WeakSet();

/** Salva o HTML do diálogo uma vez por página, para ajustar o seletor do X se precisar. */
async function dumpDialog(page, dialog) {
  if (dumpedDialogs.has(page)) return;
  dumpedDialogs.add(page);
  const html = await dialog.evaluate((el) => el.outerHTML).catch(() => null);
  if (!html) return;
  const label = (process.env.IG_INSTANCE_LABEL || 'janela').replace(/[^\w-]/g, '_');
  const file = path.join(PATHS.logs, `dialogo-o-que-aconteceu-${label}.html`);
  try { fs.writeFileSync(file, html); log.info(`HTML do diálogo salvo em ${file}.`); } catch {}
}

/** Fecha no X o diálogo "O que aconteceu", se estiver aberto. Clica direto, sem a pausa de humanClick. */
export async function dismissWhatHappened(page) {
  const dialog = page.getByRole('dialog').filter({ hasText: TEXT.whatHappened }).last();
  if (!(await dialog.isVisible().catch(() => false))) return;
  log.info('Diálogo "O que aconteceu" detectado; fechando no X.');
  const closed = () => dialog.waitFor({ state: 'hidden', timeout: 1_500 }).then(() => true, () => false);
  const icon = dialog.locator('svg[aria-label="Fechar" i], svg[aria-label="Close" i]').first();
  const attempts = [
    () => dialog.getByRole('button', { name: TEXT.close }).first().click({ timeout: 1_500 }),
    // O X costuma ser um <svg> dentro de um div role="button"; clica no elemento clicável.
    () => icon.locator('xpath=ancestor-or-self::*[@role="button" or self::button][1]').click({ timeout: 1_500 }),
    () => icon.click({ timeout: 1_500, force: true }),
    async () => {
      const box = await icon.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    () => page.keyboard.press('Escape'),
  ];
  for (const attempt of attempts) {
    await attempt().catch(() => {});
    if (await closed()) return;
  }
  await dumpDialog(page, dialog);
  log.warn('Não foi possível fechar o diálogo "O que aconteceu"; tentando de novo no próximo ciclo.');
}

/** Confere todas as páginas do contexto a cada intervalo e fecha o diálogo assim que ele aparece. */
export function watchWhatHappened(context, intervalMs = 1_000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const page of context.pages()) {
        if (!page.isClosed()) await dismissWhatHappened(page).catch(() => {});
      }
    } finally { running = false; }
  }, intervalMs);
  timer.unref();
  context.once('close', () => clearInterval(timer));
  return () => clearInterval(timer);
}

/** Lança BlockedError se houver qualquer sinal de bloqueio, captcha ou verificação. */
export async function checkForBlock(page) {
  const url = page.url();
  if (BLOCK_URL.test(url)) throw new BlockedError(`Instagram redirecionou para verificação: ${url}`);
  await dismissWhatHappened(page).catch(() => {});

  let hit;
  try {
    hit = await scanPage(page);
  } catch {
    // A página pode estar no meio de uma navegação; tenta mais uma vez.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (BLOCK_URL.test(page.url())) throw new BlockedError(`Instagram redirecionou para verificação: ${page.url()}`);
    hit = await scanPage(page);
  }
  if (hit.blocked) throw new BlockedError(`Aviso do Instagram detectado: "${hit.blocked}"`);
  if (hit.pageError) throw new PageUnavailableError(`Página indisponível: HTTP ${hit.pageError}.`);
  if (hit.unavailable) throw new CommentsUnavailableError('Instagram não conseguiu carregar os comentários.');
}
