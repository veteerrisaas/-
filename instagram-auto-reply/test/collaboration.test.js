import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { inspectPostCollaboration } from '../src/instagram/collaboration.js';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const code = 'COLLAB_TEST';
const media = (coauthors = []) => ({ code, user: { username: 'cazetv' }, coauthor_producers: coauthors });
async function fixture(t, { mode = 'desktop', data = null, html = '', json = null } = {}) {
  const device = mode === 'iphone' ? devices['iPhone 13'] : devices['Pixel 7'];
  const { defaultBrowserType, ...deviceOptions } = device;
  const context = await browser.newContext(mode === 'desktop' ? {} : deviceOptions);
  t.after(() => context.close());
  const page = await context.newPage();
  let posts = 0;
  await page.route('**/*', (route) => {
    if (route.request().method() !== 'GET') { posts++; return route.abort(); }
    return route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<main>${html}</main>${json ? `<script type="application/json">${JSON.stringify(json)}</script>` : ''}` });
  });
  await page.goto(`https://www.instagram.com/cazetv/p/${code}/`);
  if (data) await page.evaluate((data) => {
    document.querySelector('main').__reactFiber$fixture = { memoizedProps: { media: data } };
  }, data);
  return { page, posts: () => posts };
}

for (const mode of ['desktop', 'mobile', 'iphone']) {
  test(`${mode}: collab da cazetv com Igor Rodrigues é identificada sem publicar`, async (t) => {
    const { page, posts } = await fixture(t, { mode, data: media([{ username: 'euigorodrigues' }]) });
    const result = await inspectPostCollaboration(page, code);
    assert.equal(result.status, 'collab');
    assert.deepEqual(result.authors.sort(), ['cazetv', 'euigorodrigues']);
    assert.equal(posts(), 0);
  });

  test(`${mode}: menção, usuário marcado e comentário de Igor não transformam post solo em collab`, async (t) => {
    const { page } = await fixture(t, { mode,
      data: { ...media(), usertags: { in: [{ user: { username: 'euigorodrigues' } }] },
        caption: { text: 'Collab com @euigorodrigues' },
        comments: [{ user: { username: 'euigorodrigues' } }] },
      html: '<div>Confira <a href="/euigorodrigues/">@euigorodrigues</a></div><li>euigorodrigues comentou</li>' });
    assert.equal((await inspectPostCollaboration(page, code)).status, 'solo');
  });
}

test('somente uma collab de outro post nos dados não bloqueia o post atual', async (t) => {
  const { page } = await fixture(t, { data: [media(),
    { ...media([{ username: 'euigorodrigues' }]), code: 'OTHER_POST' }] });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'solo');
});

test('lista de coautores positiva prevalece sobre uma cópia antiga vazia do mesmo post', async (t) => {
  const { page } = await fixture(t, { data: [media(), media([{ username: 'euigorodrigues' }])] });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'collab');
});

test('dados JSON do post identificam collab antes da hidratação do React', async (t) => {
  const { page } = await fixture(t, { json: { data: { post: media([{ username: 'euigorodrigues' }]) } } });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'collab');
});

test('coautoria no cabeçalho identifica collab mesmo sem metadados reconhecidos', async (t) => {
  const { page } = await fixture(t, {
    html: '<article><header><a href="/cazetv/">cazetv</a> e <a href="/euigorodrigues/">euigorodrigues</a></header></article>' });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'collab');
});

test('coautores recolhidos no cabeçalho também bloqueiam a publicação', async (t) => {
  const { page } = await fixture(t, {
    html: '<header><a href="/cazetv/">cazetv</a><button>e outras 2 pessoas</button></header>' });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'collab');
});

test('convite pendente não é contado como colaboração já aceita', async (t) => {
  const { page } = await fixture(t, { data: { ...media(), invited_coauthor_producers: [{ username: 'euigorodrigues' }] } });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'solo');
});

test('autoria ausente ou metadados somente de outro post não liberam o post atual', async (t) => {
  const { page } = await fixture(t, { data: { ...media(), code: 'OTHER_POST' } });
  assert.equal((await inspectPostCollaboration(page, code)).status, 'unknown');
  assert.equal((await inspectPostCollaboration(page, 'WRONG_PAGE')).status, 'unknown');
});
