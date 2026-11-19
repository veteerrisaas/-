import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { EXCLUDED_USERS, excludedUsersFor, expandReplies, extractComments, hasUserInThread, inspectMobileThread, validateReplyThread } from '../src/instagram/comments.js';
import { sendReply } from '../src/instagram/reply.js';
import { ReplyReadLimitedError } from '../src/guard.js';

const id = '18118280044957793';
const replyId = '18100178930650247';
const cfg = { username: 'golsdodia.galo', quietHours: false, mentionUser: true,
  delays: { typingMsPerChar: [0, 0] } };
let browser;
process.argv.push('--no-action-delays');
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function row({ commentId = id, parentId = null, user = 'viewer', verified = false, absolute = false } = {}) {
  const href = absolute ? `https://www.instagram.com/${user}/?source=test` : `/${user}/`;
  const permalink = parentId ? `/p/TEST/c/${parentId}/r/${commentId}/` : `/p/TEST/c/${commentId}/`;
  return `<div data-row="${commentId}"><a href="${href}">${user}${verified ? '<svg><title>Verificado</title></svg>' : ''}</a>
    <span dir="auto">Comentário de teste</span><a href="${permalink}"><time datetime="2026-10-14T19:00:00Z">2 min</time></a>
    <button type="button" data-reply="${user}">Responder</button></div>`;
}

async function fixture(t, author = 'viewer') {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  let submissions = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      submissions++;
      const params = new URLSearchParams(request.postData());
      assert.equal(params.get('replied_to_comment_id'), id);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        status: 'ok', comment: { pk: '18128807324498434', text: params.get('comment_text') },
      }) });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
      <div data-thread="${id}">${row({ user: author })}</div>
      <form><textarea aria-label="Adicione um comentário"></textarea><button type="submit">Postar</button></form>
      </main><script>
        window.replyClicks = 0; window.postClicks = 0;
        document.addEventListener('click', (event) => {
          const button = event.target.closest('[data-reply]');
          if (button) { window.replyClicks++; document.querySelector('textarea').value = '@' + button.dataset.reply + ' '; }
        });
        document.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault(); window.postClicks++;
          await fetch('/api/v1/web/comments/TEST/add/', { method: 'POST', body: new URLSearchParams({
            replied_to_comment_id: '${id}', comment_text: document.querySelector('textarea').value,
          }) });
          document.querySelector('textarea').value = '';
        });
        // Mantém uma Fiber antiga: respostas inseridas depois não aparecem em child.
        const container = document.querySelector('[data-thread]');
        const root = { key: '${id}', child: { stateNode: container, child: null }, return: null };
        document.querySelector('time').__reactFiber\u0024test = { return: root };
      </script>` });
  });
  await page.goto('https://www.instagram.com/p/TEST/');
  return { page, submissions: () => submissions, comment: { id, author } };
}

test('correa já presente na conversa impede envio por outra conta antes de reservar ou clicar', async (t) => {
  const previous = process.env.IG_FOURTH_USERNAME;
  process.env.IG_FOURTH_USERNAME = 'correa.tipss';
  t.after(() => {
    if (previous === undefined) delete process.env.IG_FOURTH_USERNAME;
    else process.env.IG_FOURTH_USERNAME = previous;
  });
  const { page, comment, submissions } = await fixture(t);
  await extractComments(page);
  await page.locator('[data-thread]').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html),
    row({ commentId: replyId, parentId: id, user: 'correa.tipss' }));
  let reserved = 0;
  const result = await sendReply(page, comment, 'Teste', cfg, { beforeSend: () => { reserved++; return true; } });
  assert.equal(result, 'skipped');
  assert.equal(reserved, 0);
  assert.equal(submissions(), 0);
});

async function emptyReplyControl(page, { authors = [], more = false, errors = null, foreignFirst = false } = {}) {
  await page.route('**/api/graphql', (route) => {
    const parent = JSON.parse(new URLSearchParams(route.request().postData()).get('variables')).parent_comment_id;
    const edges = parent === id ? authors.map((username) => ({ node: { pk: replyId, user: { username } } })) : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: { xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection: {
        edges, page_info: { has_next_page: more, has_previous_page: false },
      } }, ...(errors ? { errors } : {}),
    }) });
  });
  await page.locator('[data-thread]').evaluate((el, { id, foreignFirst }) => {
    const button = document.createElement('button');
    button.textContent = 'Ver respostas (1)';
    button.dataset.expand = 'true';
    button.addEventListener('click', async () => {
      const read = (parent) => fetch('/api/graphql', { method: 'POST',
        headers: { 'x-fb-friendly-name': 'PolarisPostChildCommentsQuery' },
        body: new URLSearchParams({ variables: JSON.stringify({ parent_comment_id: parent }) }),
      });
      if (foreignFirst) await read('18118280044957794');
      await read(id);
      // Simula o contador antigo sem nenhuma resposta visível.
    });
    el.append(button);
  }, { id, foreignFirst });
}

for (const user of EXCLUDED_USERS) {
  test(`@golsdodia.galo não responde diretamente a @${user}`, async (t) => {
    const { page, comment, submissions } = await fixture(t, user);
    let reserved = 0;
    const result = await sendReply(page, comment, 'Teste', cfg, { beforeSend: () => { reserved++; return true; } });
    assert.equal(result, 'skipped');
    assert.equal(reserved, 0);
    assert.equal(await page.evaluate(() => window.replyClicks), 0);
    assert.equal(submissions(), 0);
  });

  test(`detecta resposta verificada de @${user} em DOM novo e Fiber antiga`, async (t) => {
    const { page, comment, submissions } = await fixture(t);
    await extractComments(page);
    await page.locator('[data-thread]').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html),
      row({ commentId: replyId, parentId: id, user, verified: true, absolute: true }));
    const result = await inspectMobileThread(page, id, EXCLUDED_USERS, comment.author);
    assert.equal(result.safe, false);
    assert.match(result.reason, new RegExp(user.replaceAll('.', '\\.')));
    assert.equal(await sendReply(page, comment, 'Teste', cfg, { beforeSend: () => assert.fail('Conversa excluída não pode reservar envio.') }), 'skipped');
    assert.equal(submissions(), 0);
  });
}

test('resposta excluída que saiu da tela continua bloqueando a conversa', async (t) => {
  const { page, comment } = await fixture(t);
  const known = [...await extractComments(page), { id: replyId, parentId: id, author: 'gabrieltipss' }];
  const result = await validateReplyThread(page, comment, { knownComments: known });
  assert.equal(result.safe, false);
  assert.match(result.reason, /gabrieltipss/);
});

test('a terceira conta também exclui a conversa ao responder com golsdodia.galo', async (t) => {
  const previous = process.env.IG_THIRD_USERNAME;
  process.env.IG_THIRD_USERNAME = 'golsdodia.cabuloso';
  t.after(() => {
    if (previous === undefined) delete process.env.IG_THIRD_USERNAME;
    else process.env.IG_THIRD_USERNAME = previous;
  });
  const { page, comment, submissions } = await fixture(t);
  await page.locator('[data-thread]').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html),
    row({ commentId: replyId, parentId: id, user: 'golsdodia.cabuloso', verified: true }));
  assert.equal(await sendReply(page, comment, 'Teste', cfg, {
    beforeSend: () => assert.fail('A terceira conta deve excluir a conversa.'),
  }), 'skipped');
  assert.equal(submissions(), 0);
});

test('respostas aninhadas e seleção de uma resposta herdam a exclusão da conversa', () => {
  const items = [{ id: 'root', author: 'viewer' },
    { id: 'child', parentId: 'root', author: 'another' },
    { id: 'grandchild', parentId: 'child', author: 'GABRIELTIPSS' }];
  assert.equal(hasUserInThread(items, 'root', '@Gabrieltipss'), true);
  assert.equal(hasUserInThread(items, 'child', 'gabrieltipss'), true);
  assert.equal(hasUserInThread(items, 'unrelated', 'gabrieltipss'), false);
});

test('resposta que perde o pai numa leitura posterior mantém o bloqueio já conhecido', async (t) => {
  const { page, comment } = await fixture(t);
  const knownComments = [{ id, author: 'viewer' }, { id: replyId, parentId: id, author: 'gabrieltipss' }];
  const freshComments = [{ id, author: 'viewer' }, { id: replyId, parentId: null, author: 'gabrieltipss' }];
  assert.equal((await validateReplyThread(page, comment, { knownComments, freshComments })).safe, false);
});

test('menção e conta excluída em outra conversa não bloqueiam comentário elegível', async (t) => {
  const { page, comment } = await fixture(t);
  await page.locator('[data-thread] [dir="auto"]').evaluate((el) => {
    el.innerHTML = 'Eu vi <a href="/gabrieltipss/">@gabrieltipss</a>';
  });
  await page.locator('main').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html),
    row({ commentId: replyId, user: 'gabrieltipss', verified: true }));
  const result = await validateReplyThread(page, comment);
  assert.equal(result.safe, true);
});

test('autor alterado ou conversa sem identificação não são liberados', async (t) => {
  const { page, comment } = await fixture(t);
  assert.equal((await validateReplyThread(page, { ...comment, author: 'different' })).safe, false);
  await page.locator('time').evaluate((time) => { delete time.__reactFiber$test; });
  assert.equal((await validateReplyThread(page, comment)).safe, false);
});

test('respostas fechadas impedem o envio', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  await page.locator('[data-thread]').evaluate((el) => el.insertAdjacentHTML('beforeend', '<button>Ver respostas (2)</button>'));
  const result = await sendReply(page, comment, 'Teste', cfg, { beforeSend: () => true });
  assert.equal(result, 'skipped');
  assert.equal(submissions(), 0);
});

test('expansão vazia confirmada libera conversa apesar do contador antigo', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page);
  assert.equal((await validateReplyThread(page, comment)).safe, false);
  await expandReplies(page, 1, id);
  const result = await validateReplyThread(page, comment);
  assert.equal(result.safe, true);
  assert.equal(result.emptyRepliesVerified, true);
  assert.equal(await sendReply(page, comment, 'Teste local', cfg, { beforeSend: () => true }), 'probably');
  assert.equal(submissions(), 1);
});

test('autor excluído na resposta da consulta bloqueia mesmo sem texto visível', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page, { authors: ['gabrieltipss'], foreignFirst: true });
  await expandReplies(page, 1, id);
  const result = await validateReplyThread(page, comment);
  assert.equal(result.safe, false);
  assert.match(result.reason, /gabrieltipss/);
  assert.equal(submissions(), 0);
});

test('terceira conta invisível no DOM também impede responder à conversa', async (t) => {
  const { page, comment } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page, { authors: ['golsdodia.cabuloso'] });
  await expandReplies(page, 1, id);
  assert.equal((await validateReplyThread(page, comment, {
    excludedUsers: excludedUsersFor('golsdodia.cabuloso'),
  })).safe, false);
});

test('leitura parcial não libera uma resposta aparentemente vazia', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page, { more: true });
  await expandReplies(page, 1, id);
  assert.equal((await validateReplyThread(page, comment)).safe, false);
  assert.equal(submissions(), 0);
});

test('limite de leitura não pode ser tratado como resposta oculta vazia', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page, { errors: [{ message: 'Rate limit exceeded' }] });
  await assert.rejects(() => expandReplies(page, 1, id), ReplyReadLimitedError);
  assert.equal((await validateReplyThread(page, comment)).safe, false);
  assert.equal(submissions(), 0);
});

test('contador alterado invalida a autorização de uma expansão vazia antiga', async (t) => {
  const { page, comment } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page);
  await expandReplies(page, 1, id);
  await page.locator('[data-expand]').evaluate((el) => { el.textContent = 'Ver respostas (2)'; });
  assert.equal((await validateReplyThread(page, comment)).safe, false);
});

test('recarregar o post não reaproveita uma leitura vazia da página anterior', async (t) => {
  const { page, comment } = await fixture(t);
  await extractComments(page);
  await emptyReplyControl(page);
  await expandReplies(page, 1, id);
  await page.reload();
  await emptyReplyControl(page);
  assert.equal((await validateReplyThread(page, comment)).safe, false);
});

test('a frase Ver respostas no texto do comentário não simula controle fechado', async (t) => {
  const { page, comment } = await fixture(t);
  await page.locator('[data-thread] [dir="auto"]').fill('Ver respostas').catch(async () => {
    await page.locator('[data-thread] [dir="auto"]').evaluate((el) => { el.textContent = 'Ver respostas'; });
  });
  assert.equal((await validateReplyThread(page, comment)).safe, true);
});

test('comentário de gabrieltipss que chega durante a reserva cancela o clique', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  // Simula uma alteração da interface durante o acesso ao registro compartilhado.
  const html = row({ commentId: replyId, parentId: id, user: 'gabrieltipss', verified: true });
  await page.evaluate((html) => {
    window.insertExcludedReply = () => document.querySelector('[data-thread]').insertAdjacentHTML('beforeend', html);
  }, html);
  let reserved = 0;
  const result = await sendReply(page, comment, 'Teste', cfg, {
    beforeSend: async () => { reserved++; await page.evaluate(() => window.insertExcludedReply()); return true; },
  });
  assert.equal(result, 'skipped');
  assert.equal(reserved, 1);
  assert.equal(await page.evaluate(() => window.postClicks), 0);
  assert.equal(submissions(), 0);
});

test('conversa elegível ainda envia uma resposta ao ID pai correto na simulação', async (t) => {
  const { page, comment, submissions } = await fixture(t);
  const result = await sendReply(page, comment, 'Teste local', cfg, { beforeSend: () => true });
  assert.equal(result, 'probably');
  assert.equal(submissions(), 1);
  assert.equal(await page.evaluate(() => window.postClicks), 1);
});
