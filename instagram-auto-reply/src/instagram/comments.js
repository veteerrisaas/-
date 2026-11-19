import { BlockedError, CommentsUnavailableError, ReplyReadLimitedError, checkForBlock } from '../guard.js';
import { humanClick, shortPause } from '../human.js';
import { TEXT } from '../selectors.js';
import { log } from '../logger.js';
import { replyReadTargets, inspectReplyRead } from './reply-read.js';

export const EXCLUDED_USERS = ['gabrieltipss', 'gabrieldastip', 'golsdodia.colorado', 'golsdodia.colorado_', 'golsdodia.galo'];
const normalizeUser = (username) => String(username || '').trim().replace(/^@/, '').toLowerCase();
export const excludedUsersFor = (...users) => [...new Set([...EXCLUDED_USERS, ...users].map(normalizeUser).filter(Boolean))];
const expansionAttempts = new WeakMap();
const replyReads = new WeakMap();

/** Conta IDs únicos de comentários principais por autor, dentro de um post. */
export function hasMultipleComments(items, username) {
  const author = username.replace(/^@/, '').toLowerCase();
  const ids = new Set(items.filter((item) => !item.parentId
    && item.author?.toLowerCase() === author).map((item) => item.id));
  return ids.size > 1;
}

/** Confere autores diretamente no componente da conversa, sem depender de parentId. */
export function inspectMobileThread(page, commentId, excludedUsers = EXCLUDED_USERS, expectedAuthor = null) {
  const replyRead = replyReads.get(page)?.threads.get(String(commentId)) || null;
  return page.evaluate(({ commentId, excludedUsers, pattern, expectedAuthor, replyRead }) => {
    const profileUser = (link) => {
      let url;
      try { url = new URL(link.getAttribute('href'), location.origin); } catch { return null; }
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
      const username = url.pathname.match(/^\/([a-z0-9._]{1,30})\/?$/i)?.[1]?.toLowerCase();
      if (!username) return null;
      // O título do SVG de verificado participa de textContent, mas não do nome.
      const clone = link.cloneNode(true);
      for (const icon of clone.querySelectorAll('svg, img, [aria-hidden="true"]')) icon.remove();
      const text = clone.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
      // Menções no corpo não são autoria de comentário.
      const compact = text.replace(/\s+/g, '');
      return [username, `${username}verificado`, `${username}verified`].includes(compact) ? username : null;
    };
    const box = document.querySelector(`[data-ar-comment="${commentId}"]`);
    const time = box?.querySelector('time');
    if (!time) return { safe: false, reason: 'comentário não localizado' };
    const author = [...box.querySelectorAll('a[href]')].map(profileUser).find(Boolean);
    if (!author || (expectedAuthor && author !== expectedAuthor.toLowerCase())) {
      return { safe: false, reason: 'autor do comentário não confirmado' };
    }
    let fiber = time[Object.keys(time).find((key) => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 60 && fiber.key !== commentId; depth++) fiber = fiber.return;
    if (!fiber || fiber.key !== commentId) return { safe: false, reason: 'conversa não identificada' };
    const elements = new Set();
    const pending = [fiber];
    let visited = 0;
    while (pending.length && visited++ < 10000) {
      const node = pending.pop();
      if (node.stateNode instanceof Element && node.stateNode.isConnected) {
        elements.add(node.stateNode);
        // React pode manter a árvore Fiber anterior após expandir respostas.
        // Os descendentes do DOM conectado contêm as respostas atuais.
        for (const el of node.stateNode.querySelectorAll('a[href], button, [role="button"], span')) elements.add(el);
      }
      for (let child = node.child; child; child = child.sibling) pending.push(child);
    }
    if (pending.length) return { safe: false, reason: 'conversa incompleta' };
    const excluded = new Set(excludedUsers.map((name) => name.toLowerCase()));
    const replyPattern = new RegExp(pattern, 'i');
    const currentRead = replyRead?.generation === `${location.href}|${performance.timeOrigin}` ? replyRead : null;
    const excludedAuthor = currentRead?.authors.find((name) => excluded.has(name));
    if (excludedAuthor) return { safe: false, reason: `@${excludedAuthor} já comentou nesta conversa` };
    // Autores são conferidos antes dos controles, inclusive respostas ocultas no DOM.
    for (const el of elements) {
      if (el.tagName === 'A') {
        const username = profileUser(el);
        if (username && excluded.has(username)) {
          return { safe: false, reason: `@${username} já comentou nesta conversa` };
        }
      }
    }
    if (currentRead && !currentRead.complete) {
      return { safe: false, reason: 'leitura das respostas não foi concluída' };
    }
    for (const el of elements) {
      const control = el.closest('button, [role="button"]')
        || (el.tagName === 'SPAN' && !el.closest('[dir="auto"]') && !el.querySelector('span') ? el : null);
      if (!control || !control.getClientRects().length) continue;
      const text = control.innerText.trim().replace(/\s+/g, ' ');
      const match = replyPattern.exec(text);
      if (!match || match.index !== 0 || !/^\s*(?:\(?\d+\)?)?\s*$/.test(text.slice(match[0].length))) continue;
      if (!currentRead?.complete || !currentRead.controls.includes(text)) {
        return { safe: false, reason: 'respostas ainda fechadas nesta conversa' };
      }
    }
    return { safe: true, emptyRepliesVerified: Boolean(currentRead?.complete && currentRead.empty) };
  }, { commentId, excludedUsers, pattern: TEXT.viewReplies.source, expectedAuthor, replyRead });
}

/** No mobile, a lista completa fica em uma página separada. */
export async function openComments(page, { timeoutMs = 15_000 } = {}) {
  if (await page.locator('a[href*="/c/"] time').count()) return;
  if (/\/comments\/?$/.test(new URL(page.url()).pathname)) return;
  const link = page.locator('a[href$="/comments/"]').first();
  const mobile = await page.evaluate(() => /Android|iPhone/.test(navigator.userAgent));
  if (!mobile && !(await link.isVisible().catch(() => false))) return;
  try {
    await link.waitFor({ state: 'visible', timeout: timeoutMs });
    await humanClick(page, link, { timeout: 120_000 });
    await page.getByRole('textbox', { name: TEXT.commentInput }).first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByText(TEXT.reply).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (err) {
    if (err.name !== 'TimeoutError') throw err;
    // A interface mobile pode não disponibilizar o link ou a lista. Essa é uma
    // falha de leitura, permitindo o mesmo tratamento das respostas indisponíveis.
    // Bloqueios, captcha e HTTP de navegação mantêm sua classificação original.
    await checkForBlock(page);
    throw new CommentsUnavailableError('A interface de comentários não ficou pronta: link, campo ou opção Responder indisponível.', { cause: err });
  }
  await checkForBlock(page);
}

/** Identifica o autor tanto no comentário principal quanto nas respostas carregadas. */
export function hasUserInThread(items, commentId, username) {
  const normalized = normalizeUser(username);
  const byId = new Map();
  for (const item of items) {
    const id = String(item.id);
    // Uma leitura virtualizada pode perder o pai, sem invalidar o vínculo já lido.
    byId.set(id, { ...item, parentId: item.parentId || byId.get(id)?.parentId || null });
  }
  const rootId = (id) => {
    const seen = new Set();
    let current = String(id);
    while (byId.get(current)?.parentId && !seen.has(current)) {
      seen.add(current);
      current = String(byId.get(current).parentId);
    }
    return current;
  };
  const root = rootId(commentId);
  return items.some((item) => normalizeUser(item.author) === normalized && rootId(item.id) === root);
}

/** Usa histórico da passagem e DOM atual; nenhuma conversa incerta é liberada. */
export async function validateReplyThread(page, comment, { knownComments = [],
  freshComments = null, excludedUsers = EXCLUDED_USERS } = {}) {
  const excluded = excludedUsersFor(...excludedUsers);
  const author = normalizeUser(comment.author);
  if (!author) return { safe: false, reason: 'autor do comentário não confirmado' };
  if (excluded.includes(author)) return { safe: false, reason: `comentário de @${author}, conta excluída` };
  const fresh = freshComments ?? await extractComments(page);
  const items = [...knownComments, ...fresh];
  const blocked = excluded.find((user) => hasUserInThread(items, comment.id, user));
  if (blocked) return { safe: false, reason: `@${blocked} já comentou nesta conversa` };
  return inspectMobileThread(page, comment.id, excluded, author);
}

/** Datas ausentes ou inválidas ficam depois dos comentários com data conhecida. */
export function newestCommentsFirst(items) {
  const timestamp = (date) => {
    const value = Date.parse(date);
    return Number.isFinite(value) ? value : -Infinity;
  };
  return items.filter((item) => !item.parentId)
    .sort((a, b) => {
      const left = timestamp(a.date);
      const right = timestamp(b.date);
      return left === right ? 0 : right - left;
    });
}

/** Seleciona a ordem cronológica quando o Instagram oferece esse controle. */
export async function selectNewestComments(page) {
  const current = page.getByRole('button', { name: TEXT.newestComments }).first();
  if (await current.isVisible().catch(() => false)) return true;
  const order = page.getByRole('button', { name: TEXT.commentOrder }).first();
  if (!(await order.isVisible().catch(() => false))) return false;
  await humanClick(page, order);
  const newest = page.getByRole('menuitem', { name: TEXT.newestComments })
    .or(page.getByRole('menuitemradio', { name: TEXT.newestComments }))
    .or(page.getByRole('option', { name: TEXT.newestComments }))
    .or(page.getByRole('button', { name: TEXT.newestComments }))
    .or(page.getByText(TEXT.newestComments)).first();
  try {
    await newest.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.keyboard.press('Escape');
    return false;
  }
  await humanClick(page, newest);
  await shortPause();
  await checkForBlock(page);
  return true;
}

/** Clica em "Carregar mais comentários" algumas vezes e expande todas as respostas. */
export async function loadComments(page, maxLoadMore) {
  if (maxLoadMore === Infinity) return loadAllComments(page);
  for (let i = 0; i < maxLoadMore; i++) {
    const btn = page.getByRole('button', { name: TEXT.loadMore }).first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await humanClick(page, btn);
    await shortPause();
    await checkForBlock(page);
  }
  return extractComments(page);
}

/** Carrega até três passagens sem IDs novos; preserva IDs de itens virtualizados. */
export async function loadAllComments(page) {
  const found = new Map();
  let idle = 0;
  while (idle < 3) {
    const before = found.size;
    for (const item of await extractComments(page)) found.set(item.id, item);
    const buttons = await page.getByRole('button', { name: TEXT.loadMore }).elementHandles();
    for (const button of buttons) {
      if (await button.isVisible().catch(() => false)) {
        await humanClick(page, button, { timeout: 3000 }).catch(() => {});
        break;
      }
    }
    await Promise.all(buttons.map((button) => button.dispose()));
    for (const item of await extractComments(page)) found.set(item.id, item);
    await page.evaluate(() => {
      const last = [...document.querySelectorAll('[data-ar-comment]')].at(-1);
      if (!last) return;
      last.scrollIntoView({ block: 'end' });
      for (let parent = last.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight + 10
          && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          parent.scrollTop = parent.scrollHeight;
          return;
        }
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    // Aguarda dados da interface, inclusive no modo sem pausas entre ações.
    await page.waitForTimeout(800);
    await checkForBlock(page);
    for (const item of await extractComments(page)) found.set(item.id, item);
    idle = found.size === before ? idle + 1 : 0;
  }
  log.info(`Carregamento concluído: ${found.size} IDs encontrados; três passagens sem comentários novos. Isso não confirma o total disponível no Instagram.`);
  return [...found.values()];
}

/** Expande "Ver respostas (N)" / "View replies (N)" para enxergar respostas já existentes. */
export async function expandReplies(page, maxClicks = 60, commentId = null) {
  const generation = await page.evaluate(() => `${location.href}|${performance.timeOrigin}`);
  let state = expansionAttempts.get(page);
  if (!state || state.generation !== generation) {
    state = { generation, keys: new Set() };
    expansionAttempts.set(page, state);
  }
  let reads = replyReads.get(page);
  if (!reads || reads.generation !== generation) {
    reads = { generation, threads: new Map() };
    replyReads.set(page, reads);
  }
  const toggles = page.getByRole('button', { name: TEXT.viewReplies })
    .or(page.getByText(TEXT.viewReplies));
  for (let clicks = 0; clicks < maxClicks; clicks++) {
    // O handle mantém o alvo: nth()/first() pode passar a apontar para outro
    // botão quando uma resposta é carregada e a lista muda.
    const candidates = await toggles.elementHandles();
    let btn = null;
    let targetId = commentId ? String(commentId) : null;
    for (const candidate of candidates) {
      const attempted = await candidate.getAttribute('data-ar-expand-failed').catch(() => '1');
      if (attempted || !(await candidate.isVisible().catch(() => false))) continue;
      if (commentId) {
        const belongs = await candidate.evaluate((el, targetId) => {
          let fiber = el[Object.keys(el).find((name) => name.startsWith('__reactFiber$'))];
          for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
            if (fiber.key === targetId) return true;
          }
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const markers = [...parent.querySelectorAll('[data-ar-comment]')];
            if (markers.length === 1) return markers[0].getAttribute('data-ar-comment') === targetId;
            if (markers.length > 1) return false;
          }
          return false;
        }, commentId).catch(() => false);
        if (!belongs) continue;
      }
      const key = await candidate.evaluate((el) => {
        let fiber = el[Object.keys(el).find((name) => name.startsWith('__reactFiber$'))];
        let id = null;
        for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
          if (/^\d{10,}$/.test(fiber.key || '')) { id = fiber.key; break; }
        }
        if (!id) {
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const markers = parent.querySelectorAll('[data-ar-comment]');
            if (markers.length === 1) { id = markers[0].getAttribute('data-ar-comment'); break; }
            if (markers.length > 1) break;
          }
        }
        return `${id || el.parentElement?.textContent.trim().slice(0, 160)}|${el.textContent.trim()}`;
      }).catch(() => null);
      if (!key || state.keys.has(key)) continue;
      state.keys.add(key);
      if (!targetId && /^\d{10,}\|/.test(key)) targetId = key.split('|')[0];
      btn = candidate;
      break;
    }
    if (!btn) {
      await Promise.all(candidates.map((candidate) => candidate.dispose()));
      return;
    }
    try {
      await btn.scrollIntoViewIfNeeded({ timeout: 2000 });
      const controlText = (await btn.innerText()).trim().replace(/\s+/g, ' ');
      const previous = reads.threads.get(targetId);
      // Uma expansão sem resposta de rede não pode liberar a conversa por acidente.
      if (targetId) reads.threads.set(targetId, { generation, authors: previous?.authors || [],
        controls: previous?.controls || [], confirmed: false, complete: false, empty: false });
      const childResponse = page.waitForResponse((response) => /(?:ChildComments|CommentReplies)/i.test(
        response.request().headers()['x-fb-friendly-name'] || '') && targetId
        && replyReadTargets(response.request(), targetId), { timeout: 5000 }).catch(() => null);
      await humanClick(page, btn, { timeout: 3000 });
      // Mesmo no modo sem pausas, aguarda a atualização desse controle.
      // A alteração visual pode acontecer antes de o servidor responder.
      // Sempre lê a resposta de rede para não perder um erro GraphQL HTTP 200.
      const result = await childResponse;
      if (result && typeof result.json === 'function') {
        const body = await result.json().catch(() => null);
        const read = inspectReplyRead(body, result.status());
        if (targetId) {
          const afterText = await btn.innerText().then((text) => text.trim().replace(/\s+/g, ' ')).catch(() => '');
          reads.threads.set(targetId, { ...read, generation,
            authors: [...new Set([...(previous?.authors || []), ...read.authors])],
            controls: [...new Set([...(previous?.controls || []), controlText, afterText].filter(Boolean))] });
        }
        if (read.limited) {
          log.warn('Instagram limitou a leitura das respostas (ChildCommentsQuery). Nenhum novo clique será feito nesta conversa nesta passagem.');
          throw new ReplyReadLimitedError('Limite do servidor ao carregar respostas; expansão adiada.');
        }
        if (read.complete && read.empty) {
          log.info(`Leitura da conversa ${targetId} concluída sem respostas acessíveis; conferindo as demais regras antes de responder.`);
        }
      }
      await shortPause();
    } catch (err) {
      if (err instanceof CommentsUnavailableError || err instanceof BlockedError) throw err;
      await btn.evaluate((el) => el.setAttribute('data-ar-expand-failed', '1')).catch(() => {});
      log.warn('Uma expansão de respostas não concluiu; avaliando os outros comentários do post.');
    } finally {
      await Promise.all(candidates.map((candidate) => candidate.dispose()));
    }
    await checkForBlock(page);
  }
  await checkForBlock(page);
}

/** Não responde quando ainda existem respostas fechadas na conversa. */
export function hasUncheckedReplies(page, commentId, topLevelIds) {
  return page.evaluate(({ commentId, topLevelIds, pattern }) => {
    const box = document.querySelector(`[data-ar-comment="${commentId}"]`);
    if (!box) return true;
    const topIds = new Set(topLevelIds);
    const re = new RegExp(pattern, 'i');
    for (let region = box; region && region !== document.body; region = region.parentElement) {
      const otherThread = [...region.querySelectorAll('[data-ar-comment]')]
        .some((el) => el !== box && topIds.has(el.getAttribute('data-ar-comment')));
      if (otherThread) break;
      const unchecked = [...region.querySelectorAll('button, [role="button"], span')]
        .some((el) => re.test(el.textContent.trim()) && el.getClientRects().length);
      if (unchecked) return true;
    }
    return false;
  }, { commentId, topLevelIds, pattern: TEXT.viewReplies.source });
}

/**
 * Lê os comentários visíveis na página do post.
 *
 * Cada comentário tem um link de data que aponta para /p/CODE/c/ID/ (respostas:
 * /p/CODE/c/PAI/r/ID/). Esse ID é a chave única. O bloco do comentário é marcado
 * com data-ar-comment="ID" para o reply.js encontrar o botão "Responder" depois.
 *
 * Retorna [{ id, parentId, author, text, date }] em ordem de exibição; parentId é
 * null para comentários de primeiro nível e date vem do <time datetime> (ISO).
 */
export function extractComments(page) {
  return page.evaluate((replySrc) => {
    const replyRe = new RegExp(replySrc, 'i');
    const USER_HREF = /^\/([A-Za-z0-9._]{1,30})\/?$/;
    const RESERVED = new Set(['explore', 'reels', 'direct', 'accounts', 'stories', 'p', 'reel']);
    const isTimeLink = (a) => a.querySelector('time');
    const timeLinkCount = (el) => [...el.querySelectorAll('a[href*="/c/"]')].filter(isTimeLink).length;

    const items = [];
    const seen = new Set();
    for (const a of [...document.querySelectorAll('a[href*="/c/"]')].filter(isTimeLink)) {
      const m = (a.getAttribute('href') || '').match(/\/c\/(\d+)(?:\/r\/(\d+))?/);
      if (!m) continue;
      const id = m[2] || m[1];
      if (seen.has(id)) continue;

      // Sobe no DOM até o menor bloco que contém autor + botão "Responder",
      // sem engolir outro comentário.
      let box = a.parentElement;
      let authorLink = null;
      for (let depth = 0; box && depth < 15; depth++, box = box.parentElement) {
        if (timeLinkCount(box) > 1) { box = null; break; }
        authorLink = [...box.querySelectorAll('a[href]')].find((l) => {
          const u = (l.getAttribute('href') || '').match(USER_HREF);
          return u && !RESERVED.has(u[1].toLowerCase()) && l.textContent.trim();
        });
        const hasReply = [...box.querySelectorAll('button, [role="button"], span')]
          .some((el) => replyRe.test(el.textContent.trim()));
        if (authorLink && hasReply) break;
        authorLink = null;
      }
      if (!box || !authorLink) continue;

      seen.add(id);
      box.setAttribute('data-ar-comment', id);
      const author = authorLink.getAttribute('href').match(USER_HREF)[1].toLowerCase();
      const text = [...box.querySelectorAll('span[dir="auto"], div[dir="auto"]')]
        .filter((el) => !el.closest('a, button, [role="button"], time'))
        .filter((el) => !el.querySelector('time, button, [role="button"], a[href*="/c/"]'))
        .map((el) => (el.textContent + [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join('')).trim())
        .filter((t) => t && t.toLowerCase() !== author)
        .sort((x, y) => y.length - x.length)[0] || '';

      let ulDepth = 0;
      for (let p = a.parentElement; p; p = p.parentElement) if (p.tagName === 'UL') ulDepth++;
      const date = a.querySelector('time').getAttribute('datetime') || null;
      items.push({ id, parentId: m[2] ? m[1] : null, author, text, date, ulDepth });
    }

    // A interface mobile não liga a data ao permalink. A chave React do
    // comentário mantém o ID original, inclusive nos comentários sem curtidas.
    // Sem ID estável, o comentário é ignorado; nunca inventamos uma chave.
    for (const time of document.querySelectorAll('time')) {
      if (time.closest('a[href*="/c/"]')) continue;
      let box = time.parentElement;
      let authorLink = null;
      for (let depth = 0; box && depth < 15; depth++, box = box.parentElement) {
        if (box.querySelectorAll('time').length > 1) { box = null; break; }
        authorLink = [...box.querySelectorAll('a[href]')].find((link) => {
          const user = (link.getAttribute('href') || '').match(USER_HREF);
          return user && !RESERVED.has(user[1].toLowerCase()) && link.textContent.trim();
        });
        const hasReply = [...box.querySelectorAll('button, [role="button"], span')]
          .some((el) => replyRe.test(el.textContent.trim()));
        if (authorLink && hasReply) break;
        authorLink = null;
      }
      if (!box || !authorLink) continue;
      let fiber = time[Object.keys(time).find((key) => key.startsWith('__reactFiber$'))];
      const ids = [];
      for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
        if (fiber.memoizedProps?.commentsQuery) break;
        if (/^\d{10,}$/.test(fiber.key || '') && !ids.includes(fiber.key)) ids.push(fiber.key);
      }
      const id = ids[0];
      if (!id || seen.has(id)) continue;
      const likedBy = box.querySelector('a[href*="/c/"]');
      const linkedId = likedBy?.getAttribute('href')?.match(/\/c\/(\d+)/)?.[1];
      if (linkedId && linkedId !== id) continue;
      const author = authorLink.getAttribute('href').match(USER_HREF)[1].toLowerCase();
      const text = [...box.querySelectorAll('span[dir="auto"], div[dir="auto"]')]
        .filter((el) => !el.closest('a, button, time'))
        .filter((el) => !el.querySelector('time, button, [role="button"]') && !el.contains(authorLink))
        .map((el) => (el.textContent + [...el.querySelectorAll('img[alt]')].map((img) => img.alt).join('')).trim())
        .filter((value) => value && value.toLowerCase() !== author && !replyRe.test(value))
        .sort((a, b) => b.length - a.length)[0] || '';
      if (!text) continue;
      seen.add(id);
      box.setAttribute('data-ar-comment', id);
      items.push({ id, parentId: ids[1] || null, author, text,
        date: time.getAttribute('datetime') || null, ulDepth: 0 });
    }

    // Reforço caso o link de uma resposta não traga /r/: se estiver mais aninhada
    // que os comentários de primeiro nível, pertence ao comentário anterior.
    const minDepth = Math.min(...items.map((i) => i.ulDepth));
    let lastTop = null;
    for (const item of items) {
      if (!item.parentId && item.ulDepth > minDepth && lastTop) item.parentId = lastTop.id;
      if (!item.parentId) lastTop = item;
      delete item.ulDepth;
    }
    return items;
  }, TEXT.reply.source);
}
