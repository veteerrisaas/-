import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { inspectPostSafety, mourningReason } from '../src/instagram/post-safety.js';

const code = 'SAFETY_TEST';
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, { mode = 'desktop', data = null, html = '', json = null, head = '' } = {}) {
  const { defaultBrowserType, ...device } = devices[mode === 'iphone' ? 'iPhone 13' : 'Pixel 7'];
  const context = await browser.newContext(mode === 'desktop' ? {} : device);
  t.after(() => context.close());
  const page = await context.newPage();
  let mutations = 0;
  await page.route('**/*', route => {
    if (route.request().method() !== 'GET') { mutations++; return route.abort(); }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<html><head>${head}</head><body><main>${html}</main>${json ? `<script type="application/json">${JSON.stringify(json)}</script>` : ''}</body></html>` });
  });
  await page.goto(`https://www.instagram.com/p/${code}/`);
  if (data) await page.evaluate(data => {
    document.querySelector('main').__reactFiber$fixture = { memoizedProps: { media: data } };
  }, data);
  return { page, mutations: () => mutations };
}

const caption = 'Rony soltou uma nota falando sobre o falecimento de seu pai, senhor Marigerson. '
  + 'A CazéTV deseja muita força aos familiares e amigos, neste momento de dor.';

for (const mode of ['desktop', 'mobile', 'iphone']) {
  test(`${mode}: legenda do exemplo de luto bloqueia sem publicar`, async t => {
    const { page, mutations } = await fixture(t, { mode, data: { code, caption: { text: caption } } });
    assert.equal((await inspectPostSafety(page, code)).safe, false);
    assert.equal(mutations(), 0);
  });
  test(`${mode}: comentário de luto de outra pessoa não bloqueia notícia esportiva`, async t => {
    const { page } = await fixture(t, { mode, data: { code, caption: { text: 'Golaço na vitória de hoje!' },
      comments: [{ text: 'Luto. Meus sentimentos.' }] }, html: '<li data-ar-comment>Luto. Meus sentimentos.</li>' });
    assert.equal((await inspectPostSafety(page, code)).safe, true);
  });
}

test('post informado pelo usuário fica bloqueado mesmo sem acesso à página', async () => {
  const page = { url: () => 'https://www.instagram.com/p/DfibQK8jYr3/?img_index=1',
    evaluate: () => { throw new Error('Não deveria ler o conteúdo de um post explicitamente bloqueado'); } };
  assert.equal((await inspectPostSafety(page)).safe, false);
});

test('luto em outro post nos dados não contamina o atual', async t => {
  const { page } = await fixture(t, { data: [
    { code, caption: 'Veja os gols do jogo!' }, { code: 'OTHER', caption },
  ] });
  assert.equal((await inspectPostSafety(page, code)).safe, true);
});

test('caption JSON do post exato identifica luto antes da hidratação', async t => {
  const { page } = await fixture(t, { json: { data: { shortcode: code,
    edge_media_to_caption: { edges: [{ node: { text: 'NOTA DE PESAR. Nossos sentimentos à família.' } }] } } } });
  assert.equal((await inspectPostSafety(page, code)).safe, false);
});

test('legenda visível é conferida sem depender de dados internos', async t => {
  const { page } = await fixture(t, { html: '<article><h1>Descanse em paz, ídolo.</h1></article>' });
  assert.equal((await inspectPostSafety(page, code)).safe, false);
});

test('metadados de outra publicação não liberam um post sem legenda', async t => {
  const { page } = await fixture(t, { head: '<meta property="og:url" content="https://www.instagram.com/p/OTHER/">'
    + '<meta property="og:description" content="Golaço!">' });
  const result = await inspectPostSafety(page, code);
  assert.equal(result.safe, false);
  assert.match(result.reason, /legenda indisponível/);
});

test('texto acessível da imagem de luto prevalece sobre legenda esportiva', async t => {
  const { page } = await fixture(t, { data: { code, caption: 'Nosso ídolo.', carousel_media: [
    { accessibility_caption: 'Imagem com texto: LUTO. Descanse em paz.' },
  ] } });
  assert.equal((await inspectPostSafety(page, code)).safe, false);
});

test('post sem legenda legível e URL divergente nunca são liberados', async t => {
  const { page } = await fixture(t);
  assert.equal((await inspectPostSafety(page, code)).safe, false);
  assert.equal((await inspectPostSafety(page, 'OTHER')).safe, false);
});

test('expressões de luto com acentos, hashtags e inglês são reconhecidas', () => {
  for (const text of ['#LUTO', 'Faleceu seu pai', 'Meus pêsames', 'Velório nesta terça',
    'Homenagem póstuma', 'RIP', 'He passed away', 'Em memória de nosso amigo']) {
    assert.ok(mourningReason(text), text);
  }
});

test('metáforas de futebol não confundem o filtro, mas não ocultam falecimento real', () => {
  for (const text of ['Grupo da morte definido!', 'Morte súbita decide o jogo', 'Morreu a jogada.',
    'Jogo de matar ou morrer', 'Torcida de saudade do título']) assert.equal(mourningReason(text), null, text);
  assert.ok(mourningReason('Grupo da morte definido. Também lamentamos o falecimento do atleta.'));
});
