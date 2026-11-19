import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { openComments } from '../src/instagram/comments.js';
import { BlockedError, CommentsUnavailableError } from '../src/guard.js';
import { BrowserReadFallback, RetryInBrowserMode } from '../src/mobile-fallback.js';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, { mode = 'iphone', link = true, replies = false, blocked = false } = {}) {
  const device = devices['iPhone 13'];
  const context = await browser.newContext(mode === 'iphone'
    ? { userAgent: device.userAgent, viewport: device.viewport, isMobile: true, hasTouch: true } : {});
  t.after(() => context.close());
  const page = await context.newPage();
  let submissions = 0;
  await page.route('**/*', async (route) => {
    if (route.request().method() !== 'GET') {
      submissions++;
      return route.abort();
    }
    const commentsPage = new URL(route.request().url()).pathname.endsWith('/comments/');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: commentsPage
      ? `<main>${blocked ? '<h1>Confirme que é você</h1>' : ''}
          <textarea aria-label="Adicione um comentário"></textarea>${replies ? '<button>Responder</button>' : ''}</main>`
      : `<main>Post${link ? '<a href="/p/TEST/comments/">Ver comentários</a>' : ''}</main>` });
  });
  await page.goto('https://www.instagram.com/p/TEST/');
  return { page, submissions: () => submissions };
}

for (const scenario of [
  { name: 'link de comentários ausente', link: false },
  { name: 'lista sem opção Responder após abrir comentários', link: true },
]) {
  test(`iPhone: ${scenario.name} vira falha de leitura e permite voltar ao desktop, sem publicar`, async (t) => {
    const { page, submissions } = await fixture(t, scenario);
    let failure;
    await assert.rejects(openComments(page, { timeoutMs: 150 }), (error) => {
      failure = error;
      return error instanceof CommentsUnavailableError && error.cause?.name === 'TimeoutError';
    });
    assert.throws(() => new BrowserReadFallback().request(failure, { enabled: true,
      username: 'golsdodia.galo', browserMode: 'iphone', post: { url: page.url() }, profile: { username: 'tntsportsbr' } }),
    (request) => request instanceof RetryInBrowserMode && request.browserMode === 'desktop');
    assert.equal(submissions(), 0);
  });
}

test('iPhone com lista pronta abre comentários sem erro nem publicação', async (t) => {
  const { page, submissions } = await fixture(t, { replies: true });
  await openComments(page, { timeoutMs: 1000 });
  assert.ok(page.url().endsWith('/comments/'));
  assert.equal(submissions(), 0);
});

test('tempo esgotado não transforma um aviso de verificação em falha que alterna a interface', async (t) => {
  const { page, submissions } = await fixture(t, { blocked: true });
  await assert.rejects(openComments(page, { timeoutMs: 150 }), BlockedError);
  assert.equal(submissions(), 0);
});

test('desktop sem link mobile mantém o comportamento de comentários dentro do post', async (t) => {
  const { page } = await fixture(t, { mode: 'desktop', link: false });
  await openComments(page, { timeoutMs: 150 });
  assert.equal(new URL(page.url()).pathname, '/p/TEST/');
});
