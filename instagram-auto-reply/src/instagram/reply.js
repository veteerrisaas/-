import { BlockedError, CommentsUnavailableError, checkForBlock } from '../guard.js';
import { log } from '../logger.js';
import { beforeClick, humanClick, humanType, rand, shortPause, sleep } from '../human.js';
import { TEXT } from '../selectors.js';
import { excludedUsersFor, extractComments, hasMultipleComments, validateReplyThread } from './comments.js';
import { waitForSchedule } from '../schedule.js';

const readInput = (input) => input.evaluate((el) => ('value' in el ? el.value : el.innerText) || '');
const norm = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Só aceita um vínculo explícito com o comentário, nunca uma menção no texto. */
export function requestRepliesTo(request, commentId) {
  const targets = [];
  // IDs do Instagram ultrapassam Number.MAX_SAFE_INTEGER. Preserva os
  // inteiros grandes como texto antes de JSON.parse, sem alterar strings.
  const parseIds = (text) => JSON.parse(text.replace(
    /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => /^\d{16,}$/.test(token) ? `"${token}"` : token,
  ));
  const parentKey = /^(replied_to_comment_id|reply_to_comment_id|parent_comment_id|parentCommentId|repliedToCommentId)$/;
  const visit = (value, depth = 0) => {
    if (depth > 15 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (parentKey.test(key)) targets.push(typeof child === 'string' ? child
        : Number.isSafeInteger(child) ? String(child) : null);
      else if (typeof child === 'object') visit(child, depth + 1);
      else if (typeof child === 'string' && /^[\[{]/.test(child.trim())) {
        try { visit(parseIds(child), depth + 1); } catch { /* Formato desconhecido: bloqueado. */ }
      }
    }
  };
  const body = request.postData() || '';
  try { visit(parseIds(body)); } catch {
    visit(Object.fromEntries(new URLSearchParams(body)));
  }
  return targets.length > 0 && targets.every((id) => id === String(commentId));
}

export async function hasReplyBanner(page, username) {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const banner = await page.getByText(new RegExp(`^(?:Respondendo a|Replying to)\\s+@?${escaped}$`, 'i'))
    .first().isVisible().catch(() => false);
  if (banner) return true;
  const desktop = await page.evaluate(() => !/Android|iPhone/.test(navigator.userAgent));
  if (!desktop) return false;
  // No desktop o clique em Responder preenche a menção sem mostrar uma faixa.
  // A requisição continua exigindo o ID pai exato antes de sair do navegador.
  const input = page.getByRole('textbox', { name: TEXT.commentInput }).first();
  const value = await readInput(input).catch(() => '');
  return new RegExp(`^@${escaped}(?:\\s|$)`, 'i').test(value);
}

/** Corrige apenas o arredondamento conhecido do ID pai no cliente mobile. */
export function repairRoundedReplyBody(body, commentId) {
  const id = String(commentId);
  if (!/^\d{16,}$/.test(id)) return body;
  const rounded = String(Number(id));
  if (rounded === id) return body;
  const fix = (json) => json.replace(
    /("(?:replied_to_comment_id|reply_to_comment_id|parent_comment_id|parentCommentId|repliedToCommentId)"\s*:\s*)(\d+)(?=\s*[,}])/g,
    (match, prefix, value) => value === rounded ? `${prefix}"${id}"` : match,
  );
  if (/^\s*\{/.test(body)) return fix(body);
  const params = new URLSearchParams(body);
  const variables = params.get('variables');
  if (!variables) return body;
  const corrected = fix(variables);
  if (corrected === variables) return body;
  params.set('variables', corrected);
  return params.toString();
}

const INTERFACE_REJECTION = /n[ãa]o foi poss[íi]vel comentar|couldn['’]?t (post )?comment|unable to (post )?comment/i;

/** Lê falhas GraphQL mesmo com HTTP 200 e sucesso no formato aninhado. */
export function classifySubmission(body, httpStatus, expectedMessage) {
  const errors = [];
  let accepted = false;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node.errors)) {
      for (const error of node.errors) {
        errors.push(String(error?.description || error?.message || error?.code || 'erro GraphQL').slice(0, 300));
      }
    }
    if (node.status === 'fail') errors.push(String(node.message || node.error_type || 'status fail').slice(0, 300));
    if ((node.pk || node.id) && typeof node.text === 'string'
      && norm(node.text).includes(norm(expectedMessage))) accepted = true;
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'errors') visit(value, depth + 1);
    }
  };
  visit(body);
  const reason = [...new Set(errors)].join('; ').replace(/[\r\n]+/g, ' ').slice(0, 500);
  const blocked = httpStatus === 403 || httpStatus === 429
    || /spam|rate.?limit|feedback_required|challenge_required|checkpoint_required|action.?blocked|try again later|tente novamente mais tarde|we restrict|restringimos/i.test(reason);
  return { httpStatus, state: blocked ? 'blocked'
    : httpStatus >= 400 || errors.length ? 'rejected'
      : accepted ? 'accepted' : 'checking', reason };
}

export function isCommentSubmission(request) {
  if (request.method() !== 'POST') return false;
  const url = new URL(request.url());
  if (/\/comments\/[^/]+\/add\/?$/.test(url.pathname)) return true;
  if (!/graphql/.test(url.pathname)) return false;
  const data = request.postData() || '';
  const friendlyName = request.headers?.()['x-fb-friendly-name'] || '';
  let decoded = data;
  try { decoded = decodeURIComponent(data.replace(/\+/g, ' ')); } catch { /* Usa o corpo original. */ }
  return /(?:create|add|post)_?comment/i.test(`${friendlyName} ${decoded}`)
    || /comment_text|replied_to_comment_id/i.test(decoded);
}

/**
 * Responde a um comentário: clica em "Responder", ajusta a menção, digita a
 * mensagem, chama beforeSend() (que grava "pending") e envia.
 *
 * Retorna:
 *  - 'confirmed': a resposta apareceu na thread do comentário;
 *  - 'probably':  o campo foi limpo (enviado), mas a resposta não foi localizada;
 *  - 'unknown':   o texto continua no campo; não dá para saber se foi enviado;
 *  - 'rejected':  o Instagram respondeu "Não foi possível comentar" (não enviado).
 */
export async function sendReply(page, comment, message, cfg, { beforeSend, knownComments = [] }) {
  await waitForSchedule(cfg);
  const excludedUsers = excludedUsersFor(cfg.username, process.env.IG_USERNAME, process.env.IG_SECOND_USERNAME, process.env.IG_THIRD_USERNAME, process.env.IG_FOURTH_USERNAME, process.env.IG_RESERVE_USERNAME);
  const inspect = (freshComments = null) => validateReplyThread(page, comment, { knownComments, freshComments, excludedUsers });
  const initialThread = await inspect();
  if (!initialThread.safe) {
    log.info(`  envio cancelado para @${comment.author}: ${initialThread.reason}.`);
    return 'skipped';
  }
  const instantInput = cfg.delays.typingMsPerChar.every((ms) => ms === 0);
  const pacedInput = !instantInput && cfg.delays.typingMsPerChar[1] > 20;
  const box = page.locator(`[data-ar-comment="${comment.id}"]`);
  if (!(await box.count())) await extractComments(page);
  if (!(await box.count())) throw new Error(`Comentário ${comment.id} não encontrado na página.`);

  const replyBtn = box.getByRole('button', { name: TEXT.reply }).or(box.getByText(TEXT.reply)).first();
  await replyBtn.scrollIntoViewIfNeeded();
  if (pacedInput) await shortPause();
  await humanClick(page, replyBtn);

  const input = page.getByRole('textbox', { name: TEXT.commentInput }).first();
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  if (pacedInput) await sleep(rand(500, 1200));
  // O campo pode aparecer antes do estado de resposta estar pronto.
  for (let check = 0; check < 10 && !(await hasReplyBanner(page, comment.author)); check++) {
    await sleep(200);
  }
  if (!(await hasReplyBanner(page, comment.author))) {
    log.warn(`  envio cancelado: estado de resposta a @${comment.author} não confirmado.`);
    return 'skipped';
  }

  // O Instagram preenche "@usuario " sozinho ao clicar em Responder.
  const mention = `@${comment.author}`;
  if (instantInput) {
    await input.fill(`${cfg.mentionUser ? `${mention} ` : ''}${message}`);
  } else {
    const prefilled = await readInput(input);
    if (!cfg.mentionUser) {
      await input.fill('');
    } else if (!prefilled.toLowerCase().includes(mention.toLowerCase())) {
      await input.fill('');
      await humanClick(page, input);
      await humanType(page, mention, cfg.delays.typingMsPerChar);
    }
    await humanClick(page, input);
    await page.keyboard.press('End');
    const current = await readInput(input);
    if (current && !/\s$/.test(current)) await page.keyboard.type(' ');

    await humanType(page, message, cfg.delays.typingMsPerChar);
    if (pacedInput) await sleep(rand(800, 2000));
  }

  const typed = norm(await readInput(input));
  if (!typed.includes(norm(message))) {
    throw new Error(`Texto no campo não confere com a mensagem ("${typed}"); envio cancelado.`);
  }

  const form = input.locator('xpath=ancestor::form[1]');
  const postBtn = form.getByRole('button', { name: TEXT.post }).or(form.getByText(TEXT.post)).first();
  try {
    await postBtn.waitFor({ state: 'visible', timeout: 10_000 });
    if (!(await postBtn.isEnabled())) throw new Error('Botão desabilitado.');
  } catch {
    await input.fill('').catch(() => {});
    throw new Error('Botão de envio ausente ou desabilitado; não houve tentativa de envio.');
  }

  let submission = null;
  let observedRequests = 0;
  let invalidTarget = false;
  const guardRoute = async (route) => {
    const request = route.request();
    if (isCommentSubmission(request) && !requestRepliesTo(request, comment.id)) {
      if (await hasReplyBanner(page, comment.author)) {
        const corrected = repairRoundedReplyBody(request.postData() || '', comment.id);
        if (requestRepliesTo({ postData: () => corrected }, comment.id)) {
          log.info(`  ID pai corrigido para ${comment.id}; vínculo da resposta confirmado.`);
          await route.fallback({ postData: corrected });
          return;
        }
      }
      invalidTarget = true;
      log.error(`  publicação bloqueada localmente: requisição sem vínculo com o comentário ${comment.id}.`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  };
  const onRequest = (request) => {
    if (request.method() !== 'POST') return;
    const route = new URL(request.url()).pathname;
    if (!/graphql|\/comments\//.test(route)) return;
    observedRequests++;
    const friendlyName = (request.headers()['x-fb-friendly-name'] || '')
      .replace(/[^a-zA-Z0-9_]/g, '').slice(0, 120);
    log.info(`  atividade após clique: POST ${route}; operação ${friendlyName || 'não informada'}; comentário identificado: ${isCommentSubmission(request)}.`);
  };
  const onResponse = async (response) => {
    if (!isCommentSubmission(response.request())) return;
    const httpStatus = response.status();
    submission = { httpStatus, state: 'checking' };
    try {
      const body = await response.json();
      submission = classifySubmission(body, httpStatus, message);
    } catch {
      submission = { httpStatus, state: httpStatus >= 400 ? 'rejected' : 'checking' };
    }
    log.info(`  requisição de comentário: HTTP ${httpStatus}, ${submission.state}.`);
    if (submission.reason) log.warn(`  motivo informado pelo Instagram: ${submission.reason}`);
  };
  const onFailed = (request) => {
    if (!isCommentSubmission(request)) return;
    submission = { state: 'failed' };
    log.warn('  requisição de comentário falhou na rede; não haverá nova tentativa automática.');
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('request', onRequest);
  try {
    // Aguarda antes das conferências finais para não inserir uma pausa após a validação.
    await beforeClick(page);
    await waitForSchedule(cfg);
    await checkForBlock(page);
    const freshComments = await extractComments(page);
    if (hasMultipleComments([...knownComments, ...freshComments], comment.author)) {
      await input.fill('').catch(() => {});
      log.info(`  envio cancelado para @${comment.author}: usuário tem mais de um comentário neste post.`);
      return 'skipped';
    }
    const thread = await inspect(freshComments);
    if (!thread.safe) {
      await input.fill('').catch(() => {});
      log.info(`  envio cancelado para @${comment.author}: ${thread.reason}.`);
      return 'skipped';
    }
    if (!(await hasReplyBanner(page, comment.author))) {
      await input.fill('').catch(() => {});
      log.warn(`  envio cancelado: estado de resposta a @${comment.author} foi perdido.`);
      return 'skipped';
    }
    await page.route('**/*', guardRoute);
    if (await beforeSend() === false) {
      await input.fill('').catch(() => {});
      log.info('  envio cancelado: comentário reservado por outra instância ou limite diário compartilhado atingido.');
      return 'skipped';
    }
    // A reserva pode aguardar outra instância. Confere novamente após a reserva.
    const finalThread = await inspect();
    if (!finalThread.safe) {
      await input.fill('').catch(() => {});
      log.info(`  envio cancelado antes do clique para @${comment.author}: ${finalThread.reason}.`);
      return 'skipped';
    }
    log.info('  clicando no botão de envio; aguardando o resultado.');
    await postBtn.click();
    const deadline = Date.now() + 20_000;
    let clearedChecks = 0;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (invalidTarget) {
        await input.fill('').catch(() => {});
        return 'wrong-target';
      }
      if (submission?.httpStatus === 429) {
        await input.fill('').catch(() => {});
        log.warn('  HTTP 429 no envio interno; mantendo a instância aberta, sem repetir esta mensagem.');
        return 'rate-limited';
      }
      try {
        await checkForBlock(page);
      } catch (err) {
        if (!(err instanceof CommentsUnavailableError)) throw err;
        if (submission?.state === 'accepted') {
          log.info('  servidor aceitou a resposta; falha posterior ao carregar comentários não invalida esse resultado.');
          return 'probably';
        }
        log.warn('  comentários indisponíveis após o clique; envio mantido como pendente.');
        return 'unknown';
      }
      if (submission?.state === 'blocked' || submission?.httpStatus === 429 || submission?.httpStatus === 403) {
        throw new BlockedError(`Envio recusado pelo Instagram (HTTP ${submission.httpStatus}): ${submission.reason || 'restrição de envio'}; serviço interrompido.`);
      }
      if (submission?.state === 'rejected' || submission?.state === 'failed') {
        await input.fill('').catch(() => {});
        // Recusa genérica costuma ser da interface atual; a troca para outra interface pode resolver.
        return INTERFACE_REJECTION.test(submission.reason || '') ? 'rejected' : 'unknown';
      }
      const items = await extractComments(page);
      if (items.some((i) => i.parentId === comment.id && i.author === cfg.username
        && norm(i.text).includes(norm(message)))) return 'confirmed';
      if (submission?.state === 'accepted') return 'probably';
      // Duas leituras vazias evitam esperar 20s quando a interface já aceitou o envio.
      // Isso continua sendo "probably", sem atribuir confirmação à limpeza do campo.
      const remaining = await readInput(input).catch(() => null);
      clearedChecks = remaining !== null && norm(remaining) === '' ? clearedChecks + 1 : 0;
      if (clearedChecks >= 2) return 'probably';
    }
    const remaining = await readInput(input).catch(() => null);
    const left = remaining === null ? null : norm(remaining);
    log.warn(`  confirmação expirou; requisição: ${submission?.state || 'não identificada'}; requisições observadas: ${observedRequests}; texto no campo: ${left === null ? 'indisponível' : left ? 'presente' : 'vazio'}.`);
    return left === '' ? 'probably' : 'unknown';
  } finally {
    await page.unroute('**/*', guardRoute).catch(() => {});
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
    page.off('request', onRequest);
  }
}
