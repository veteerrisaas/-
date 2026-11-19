import { IG_URL, dismissPopups, isLoggedIn, openBrowser } from './browser.js';
import { PATHS, loadConfig } from './config.js';
import { BlockedError, CommentsUnavailableError, ReplyReadLimitedError, PageUnavailableError, SendRejectedError, getNavigationStatus, checkForBlock, monitorRateLimits } from './guard.js';
import { configureClickDelay, pause, rand, sleep } from './human.js';
import { log, screenshot } from './logger.js';
import { isEmojiOnly, isSelfHarmComment, pickMessage } from './message.js';
import { Store } from './store.js';
import { MessageBank, loadMessageTemplates } from './message-bank.js';
import path from 'node:path';
import { excludedUsersFor, expandReplies, extractComments, hasMultipleComments, validateReplyThread, loadComments, newestCommentsFirst, openComments, selectNewestComments } from './instagram/comments.js';
import { getRecentPosts } from './instagram/profile.js';
import { getPostCommentCount } from './instagram/comment-count.js';
import { inspectPostCollaboration } from './instagram/collaboration.js';
import { inspectPostSafety } from './instagram/post-safety.js';
import { sendReply } from './instagram/reply.js';
import { likeComment } from './instagram/like.js';
import { ActivityBreak } from './activity-break.js';
import { waitForSchedule } from './schedule.js';
import { PostRetryQueue } from './post-retry.js';
import { BrowserReadFallback, RetryInBrowserMode, supportsBrowserReadFallback, browserModeLabel, browserReadCycleLabel } from './mobile-fallback.js';
import { attachSessionExport, waitForSessionInitialization } from './session-transfer.js';

// Códigos de saída: 0 ok, 1 erro, 2 bloqueio/captcha detectado, 3 sem sessão.
class NotLoggedInError extends Error {}
class UncertainSendError extends Error {}
const unavailablePosts = new PostRetryQueue();
const mobileFallback = new BrowserReadFallback();
// Recusas seguidas são encaminhadas ao acompanhamento para trocar a conta ou a interface.
const MAX_SEND_REJECTIONS = 3;
let sendRejections = 0;
const modeLabel = browserModeLabel;
let messageBank;

function configureMessageBank(cfg) {
  if (!cfg.messageBank) return;
  // Simulação importa o histórico em memória; não altera o banco persistente.
  messageBank ??= new MessageBank(cfg.dryRun ? ':memory:' : cfg.messageBank.file);
  messageBank.importHistory(path.dirname(cfg.dataPath));
  cfg.messageTemplates = loadMessageTemplates(cfg.messageBank.templatesFile);
  cfg.messageBankInstance = messageBank;
}

// run: limite global da execução; quota: limite do perfil atual (maxPerRun do profiles.json).
const reachedLimit = (run, quota) => run.replied >= run.budget || quota.replied >= quota.max;

async function processPost(page, post, profile, cfg, store, run, quota) {
  await cfg.activityBreak.waitIfDue();
  await waitForSchedule(cfg);
  log.info(`Post ${post.url}${post.pinned ? ' (fixado)' : ''}`);
  await page.goto(post.url, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await checkForBlock(page);
  await dismissPopups(page);
  const postSafety = await inspectPostSafety(page, post.code);
  if (!postSafety.safe) {
    log.info(`  pulando post: ${postSafety.reason}. Nenhum comentário será respondido nesta publicação.`);
    return;
  }
  const collaboration = await inspectPostCollaboration(page, post.code);
  if (collaboration.status !== 'solo') {
    log.info(collaboration.status === 'collab'
      ? `  pulando post: publicação em collab${collaboration.authors.length ? ` (${collaboration.authors.map((user) => `@${user}`).join(', ')})` : ''}.`
      : '  pulando post: não foi possível confirmar que a publicação está sem collab.');
    return;
  }
  if (cfg.minPostComments > 0) {
    const total = await getPostCommentCount(page);
    if (total === null || total < cfg.minPostComments) {
      log.info(`  pulando post: ${total === null ? 'total de comentários não identificado' : `${total} comentários`}; mínimo exigido: ${cfg.minPostComments}.`);
      return;
    }
    log.info(`  post elegível: pelo menos ${total} comentários; mínimo ${cfg.minPostComments}.`);
  }
  await openComments(page);
  const chronological = await selectNewestComments(page);
  log.info(chronological
    ? '  comentários: Mais recentes selecionado.'
    : '  opção Mais recentes indisponível; ordenando os comentários carregados por data.');
  const loadedItems = await loadComments(page, cfg.loadAllComments ? Infinity : cfg.maxLoadMore);
  await checkForBlock(page);

  const items = loadedItems || await extractComments(page);
  if (!items.length && await page.getByText(/^(Responder|Reply)$/i).first().isVisible().catch(() => false)) {
    throw new CommentsUnavailableError('Comentários visíveis, mas sem IDs reconhecidos; nenhum envio iniciado.');
  }
  run.commentLoadFailures = 0;
  // Mais recentes primeiro (o Instagram exibe por relevância); sem data vão para o fim.
  const comments = newestCommentsFirst(items);
  const seenComments = new Map(items.map((item) => [item.id, item]));
  const excludedUsers = excludedUsersFor(cfg.username, process.env.IG_USERNAME, process.env.IG_SECOND_USERNAME, process.env.IG_THIRD_USERNAME, process.env.IG_FOURTH_USERNAME, process.env.IG_RESERVE_USERNAME);
  log.info(`  ${comments.length} comentários e ${items.length - comments.length} respostas carregados.`);

  for (const c of comments) {
    if (reachedLimit(run, quota)) return;
    const who = `@${c.author} (${c.id})`;

    if (excludedUsers.includes(c.author?.toLowerCase())) {
      log.info(`  pulando ${who}: comentário de uma das contas excluídas.`);
      continue;
    }
    if (isSelfHarmComment(c.text)) {
      log.info(`  pulando ${who}: comentário com intenção explícita de autoagressão; sem resposta automática.`);
      continue;
    }
    let currentItems = await extractComments(page);
    for (const item of currentItems) seenComments.set(item.id, item);
    if (hasMultipleComments([...seenComments.values()], c.author)) {
      log.info(`  pulando ${who}: usuário tem mais de um comentário neste post.`);
      continue;
    }
    const inspect = () => validateReplyThread(page, c, {
      knownComments: [...items, ...seenComments.values()], freshComments: currentItems, excludedUsers,
    });
    let thread = await inspect();
    if (!thread.safe && thread.reason === 'respostas ainda fechadas nesta conversa') {
      log.info(`  conferindo somente as respostas de ${who}.`);
      await expandReplies(page, 20, c.id);
      currentItems = await extractComments(page);
      for (const item of currentItems) seenComments.set(item.id, item);
      thread = await inspect();
    }
    if (!thread.safe) {
      log.info(`  pulando ${who}: ${thread.reason}.`);
      continue;
    }
    if (cfg.maxCommentAgeMin > 0) {
      const parsedDate = Date.parse(c.date);
      const ageMin = Number.isFinite(parsedDate) ? (Date.now() - parsedDate) / 60_000 : Infinity;
      if (ageMin > cfg.maxCommentAgeMin) {
        // A lista está do mais novo para o mais antigo: daqui para baixo todos são antigos.
        log.info(`  demais comentários têm mais de ${cfg.maxCommentAgeMin} min; indo para o próximo post.`);
        return;
      }
    }
    if (store.has(c.id)) {
      log.info(`  pulando ${who}: já está no registro.`);
      continue;
    }
    if (currentItems.some((r) => r.parentId === c.id && r.author === cfg.username)) {
      log.info(`  pulando ${who}: já existe resposta sua.`);
      continue;
    }
    if (cfg.ignoreEmojiOnly && isEmojiOnly(c.text)) {
      log.info(`  pulando ${who}: só emoji ("${c.text}").`);
      continue;
    }

    if (await cfg.activityBreak.waitIfDue()) await checkForBlock(page);
    await waitForSchedule(cfg);
    const message = cfg.messageBankInstance
      ? cfg.messageBankInstance.reserve(profile.messages, cfg.messageTemplates)
      : pickMessage(profile.messages);
    if (!message) {
      throw new UncertainSendError('Banco de mensagens esgotado. Nenhum texto será repetido; amplie os modelos antes de retomar.');
    }
    const shouldLike = Math.random() < cfg.likeProbability;
    const preview = cfg.mentionUser ? `@${c.author} ${message}` : message;

    if (cfg.dryRun) {
      log.dry(`  sorteio de curtida para ${who}: ${shouldLike ? 'curtir' : 'nao curtir'}.`);
      log.dry(`  [@${profile.username}] responderia ${who} "${c.text.slice(0, 80)}" com: "${preview}"`);
      run.replied++;
      quota.replied++;
      continue;
    }

    log.info(`  respondendo ${who} "${c.text.slice(0, 80)}" com: "${preview}"`);
    let result;
    let reservedByThisAttempt = false;
    try {
    result = await sendReply(page, c, message, cfg, {
      knownComments: [...items, ...seenComments.values()],
      beforeSend: async () => {
        if (cfg.messageBankInstance) {
          let wait;
          while ((wait = cfg.messageBankInstance.claimSendSlot(cfg.username, cfg.delays.betweenRepliesSec)) > 0) {
            log.info(`  aguardando ${Math.ceil(wait / 1000)}s: intervalo compartilhado entre mensagens da conta.`);
            await sleep(wait);
            if (shutdownRequested) return false;
          }
        }
        reservedByThisAttempt = store.markPending(c.id, {
        profile: profile.username,
        post: post.url,
        commentUrl: `${post.url}c/${c.id}/`,
        author: c.author,
        comment: c.text,
        commentedAt: c.date,
        reply: preview,
        }, cfg.limits.maxPerDay);
        return reservedByThisAttempt;
      },
    });
    } catch (err) {
      if (shutdownRequested || err instanceof BlockedError) throw err;
      if (reservedByThisAttempt) {
        throw new UncertainSendError(`Falha após reservar o envio para ${who}: ${err.message}. Registro pendente preservado; nenhuma repetição automática.`);
      }
      log.warn(`  falha antes de enviar para ${who}: ${err.message}; avaliando o próximo comentário.`);
      continue;
    }
    if (result === 'skipped') continue;
    if (result === 'rate-limited') {
      log.warn('Pausa de 60 segundos após HTTP 429 interno; processo permanece aberto.');
      await sleep(60_000);
      return;
    }
    if (result === 'wrong-target') {
      throw new UncertainSendError('Publicação bloqueada localmente: o envio não apontava para o comentário correto. Serviço interrompido sem repetir o envio.');
    }
    run.replied++;
    quota.replied++;

    if (result === 'confirmed') {
      if (cfg.accountFailover && process.connected) process.send({ type: 'send-success', username: cfg.username, browserMode: cfg.browserMode }, () => {});
      run.uncertainSends = 0;
      sendRejections = 0;
      store.markSent(c.id);
      log.info(`  ✔ resposta confirmada (${run.replied}/${run.budget} nesta execução).`);
    } else if (result === 'probably') {
      if (cfg.accountFailover && process.connected) process.send({ type: 'send-success', username: cfg.username, browserMode: cfg.browserMode }, () => {});
      run.uncertainSends = 0;
      sendRejections = 0;
      store.markSent(c.id, { verified: false });
      log.warn('  resposta enviada, mas não localizada na thread. Marcada como enviada (não verificada).');
    } else {
      await screenshot(page, `envio-incerto_${c.id}`);
      if (!(await isLoggedIn(page.context()))) {
        throw new NotLoggedInError('O Instagram encerrou a sessão durante os envios; registro pendente preservado.');
      }
      if (result === 'rejected') {
        sendRejections++;
        if (sendRejections >= MAX_SEND_REJECTIONS) {
          throw new SendRejectedError(`${sendRejections} envios seguidos recusados pelo Instagram em ${modeLabel(cfg.browserMode)} ("Não foi possível comentar")`);
        }
        log.warn(`  envio para ${who} recusado pelo Instagram; ${sendRejections}/${MAX_SEND_REJECTIONS} recusas seguidas antes de trocar de interface.`);
      }
      run.uncertainSends = (run.uncertainSends || 0) + 1;
      if (run.uncertainSends >= 8) {
        throw new UncertainSendError('Oito envios consecutivos sem confirmação. Serviço interrompido; registros pendentes preservados.');
      }
      log.warn(`  envio para ${who} ficou pendente e não será repetido; avaliando o próximo comentário (${run.uncertainSends}/8 falhas consecutivas).`);
      await checkForBlock(page);
      await pause(cfg.delays.betweenRepliesSec, 'após envio incerto');
      continue;
    }

    await checkForBlock(page);
    if (shouldLike) {
      await waitForSchedule(cfg);
      try {
        const liked = await likeComment(page, c);
        log.info(`  curtida para ${who}: ${liked}.`);
      } catch (err) {
        if (err instanceof BlockedError || err instanceof CommentsUnavailableError) throw err;
        log.warn(`  nao foi possivel curtir ${who}: ${err.message}; sem repetir o clique.`);
      }
    }
    if (run.replied < run.budget) await pause(cfg.delays.betweenRepliesSec, 'entre respostas, inclusive na troca de perfil');
  }
  if (comments.length) {
    mobileFallback.succeeded();
    if (cfg.syncBrowserModes && process.connected) process.send({ type: 'read-mode-success',
      username: cfg.username, browserMode: cfg.browserMode }, () => {});
  }
}

async function processProfile(page, profile, cfg, store, run) {
  const quota = { replied: run.retryQuota?.get(profile.username) || 0, max: profile.maxPerRun };
  const recentPosts = await getRecentPosts(page, profile.username, profile.postsToCheck, profile.skipPinned);
  const posts = recentPosts.filter((_, i) => i % cfg.shardCount === cfg.shardIndex);
  run.postUrls.push(...posts.map((post) => post.url));
  log.info(`${posts.length} posts para verificar em @${profile.username}.`);

  for (const [i, post] of posts.entries()) {
    if (run.retriedPost === post.url) continue;
    const pending = unavailablePosts.get(post.url);
    if (pending) {
      const remainingSec = Math.ceil((pending.retryAt - Date.now()) / 1000);
      log.info(`Pulando ${post.url}: ${pending.reason}. Nova tentativa em ${Math.ceil(remainingSec / 60)} min, às ${new Date(pending.retryAt).toLocaleTimeString('pt-BR')}.`);
      continue;
    }
    if (reachedLimit(run, quota)) {
      log.info(`Limite atingido para @${profile.username}.`);
      break;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await processPost(page, post, profile, cfg, store, run, quota);
        break;
      } catch (err) {
        if (shutdownRequested) throw err;
        if (err instanceof SendRejectedError) {
          sendRejections = 0;
          mobileFallback.request(err, { enabled: cfg.mobileFallback, username: cfg.username, browserMode: cfg.browserMode, post, profile });
          log.warn(`${err.message}; troca de interface indisponível para esta conta. Seguindo para outro post.`);
          break;
        }
        if (err instanceof ReplyReadLimitedError) {
          mobileFallback.request(err, { enabled: cfg.mobileFallback, username: cfg.username, browserMode: cfg.browserMode, post, profile });
          unavailablePosts.defer(post.url, `leitura das respostas recusada pelo servidor: ${err.message}`);
          log.warn(`Leitura das respostas recusada pelo servidor em ${post.url}; adiada por 30 minutos, sem recarregar esse post agora.`);
          break;
        }
        if (err instanceof PageUnavailableError || getNavigationStatus(page) >= 400) {
          unavailablePosts.defer(post.url, `erro de navegação: ${err.message}`);
          log.warn(`Pulando ${post.url}: HTTP ${getNavigationStatus(page) || 429}; seguindo para outro post.`);
          break;
        }
        if (err instanceof BlockedError || err instanceof UncertainSendError || err instanceof NotLoggedInError) throw err;
        try { await checkForBlock(page); } catch (screenError) {
          if (screenError instanceof CommentsUnavailableError) {
            err = screenError;
          } else {
          if (!(screenError instanceof PageUnavailableError)) throw screenError;
          unavailablePosts.defer(post.url, `erro HTTP visível: ${screenError.message}`);
          log.warn(`Pulando ${post.url}: erro HTTP visível; seguindo para outro post.`);
          break;
          }
        }
        await screenshot(page, `erro_${post.code}`);
        if (err instanceof CommentsUnavailableError) {
          run.commentLoadFailures = (run.commentLoadFailures || 0) + 1;
          if (attempt === 0) {
            log.warn('Comentários indisponíveis; aguardando 30s antes de recarregar o post uma vez. Envios pendentes não serão repetidos.');
            await sleep(30_000);
            if (reachedLimit(run, quota)) break;
            continue;
          }
          mobileFallback.request(err, { enabled: cfg.mobileFallback, username: cfg.username, browserMode: cfg.browserMode, post, profile });
          unavailablePosts.defer(post.url, `comentários indisponíveis após duas tentativas: ${err.message}`);
          log.warn(`Comentários continuam indisponíveis em ${post.url}; pulando esse endereço por 30 minutos e seguindo para outro post. As outras instâncias continuam abertas.`);
        } else {
          log.error(`Erro no post ${post.url}: ${err.message}`);
        }
        break;
      }
    }
    if (!cfg.dryRun && i < posts.length - 1) await pause(cfg.delays.betweenPostsSec, 'entre posts');
  }
  return quota.replied;
}

/** Retorna a espera quando todos os posts falharam; false se atingiu o limite diário. */
async function runCycle(context, page, cfg, store, retryPost = null) {
  const doneToday = store.countToday();
  const budget = Math.min(cfg.limits.maxPerRun, cfg.limits.maxPerDay - doneToday);
  log.info(`Hoje: ${doneToday}/${Number.isFinite(cfg.limits.maxPerDay) ? cfg.limits.maxPerDay : 'sem limite'}. Limite deste ciclo: ${Number.isFinite(budget) ? Math.max(budget, 0) : 'sem limite'}.`);
  if (budget <= 0) {
    log.info('Limite diário atingido.');
    return false;
  }

  await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  await checkForBlock(page);
  if (!(await isLoggedIn(context)) || page.url().includes('/accounts/login')) {
    throw new NotLoggedInError('Sessão não encontrada ou expirada. Rode "npm run login".');
  }
  await dismissPopups(page);

  const run = { replied: 0, budget, postUrls: [] };
  if (retryPost) {
    const profile = cfg.profiles.find((item) => item.username === retryPost.profile.username);
    if (profile) {
      const quota = { replied: 0, max: profile.maxPerRun };
      run.retriedPost = retryPost.post.url;
      log.info(`Retomando o post após a troca para ${modeLabel(cfg.browserMode)}: ${retryPost.post.url}`);
      try {
        await processPost(page, retryPost.post, profile, cfg, store, run, quota);
      } catch (err) {
        if (shutdownRequested || err instanceof BlockedError || err instanceof NotLoggedInError
          || err instanceof UncertainSendError) throw err;
        mobileFallback.request(err, { enabled: cfg.mobileFallback, username: cfg.username,
          browserMode: cfg.browserMode, post: retryPost.post, profile });
        unavailablePosts.defer(retryPost.post.url, `tentativa em ${modeLabel(cfg.browserMode)} falhou: ${err.message}`);
        log.warn(`Tentativa em ${modeLabel(cfg.browserMode)} falhou; post adiado por 30 minutos: ${err.message}`);
      }
      run.retryQuota = new Map([[profile.username, quota.replied]]);
      if (run.replied >= run.budget) return { retryWaitMs: 0 };
    }
  }
  const summary = [];
  for (const [i, profile] of cfg.profiles.entries()) {
    if (run.replied >= run.budget) {
      log.info('Limite do ciclo atingido; perfis restantes ficam para o próximo.');
      break;
    }
    log.info(`=== Perfil @${profile.username} (${i + 1}/${cfg.profiles.length}) ===`);
    try {
      summary.push(`@${profile.username}: ${await processProfile(page, profile, cfg, store, run)}`);
    } catch (err) {
      if (shutdownRequested) throw err;
      if (err instanceof BlockedError || err instanceof UncertainSendError || err instanceof RetryInBrowserMode) throw err;
      // Ex.: perfil privado, inexistente ou com o nome errado no profiles.json.
      log.error(`Erro no perfil @${profile.username}: ${err.message}`);
      await screenshot(page, `erro_perfil_${profile.username}`);
      summary.push(`@${profile.username}: erro`);
    }
    if (!cfg.dryRun && i < cfg.profiles.length - 1) await pause(cfg.delays.betweenPostsSec, 'entre perfis');
  }

  log.info(`Fim do ciclo. ${cfg.dryRun ? 'Respostas simuladas' : 'Respostas enviadas'}: ${run.replied} (${summary.join(', ')}).`);
  return { retryWaitMs: unavailablePosts.idleWait(run.postUrls) };
}

/** Está dentro do horário de funcionamento (activeHours: [início, fim])? */
function inActiveHours(cfg, now = new Date()) {
  const hour = now.getHours() + now.getMinutes() / 60;
  return hour >= cfg.activeHours[0] && hour < cfg.activeHours[1];
}

/** Dorme até o próximo início do horário de funcionamento (hoje ou amanhã), com alguns minutos aleatórios. */
async function sleepUntilStart(cfg, reason) {
  const next = new Date();
  next.setHours(cfg.activeHours[0], 0, 0, 0);
  if (next <= Date.now()) next.setDate(next.getDate() + 1);
  const ms = next - Date.now() + rand(1, 10) * 60_000;
  log.info(`${reason} Retomando por volta de ${new Date(Date.now() + ms).toLocaleString('pt-BR')}.`);
  await sleep(ms);
}

const MAX_CONSECUTIVE_FAILURES = 5;
let shutdownRequested = false;
let stopInstance;
let resumePair;
const pairResumed = new Promise((resolve) => { resumePair = resolve; });
process.on('message', (message) => {
  if (message === 'resume' || message?.type === 'resume') { resumePair(message); return; }
  if (message !== 'shutdown') return;
  shutdownRequested = true;
  if (stopInstance) void stopInstance();
});

async function main() {
  const watch = process.argv.includes('--watch');
  let cfg = loadConfig();
  configureMessageBank(cfg);
  if (cfg.syncBrowserModes && (!cfg.managedPair || !process.connected)) {
    throw new Error('Use watch:2:account2 ou watch:2:account3 para sincronizar as duas interfaces.');
  }
  if (cfg.managedPair && !process.connected) throw new Error('Use o inicializador watch:2:accounts para este modo.');
  if (cfg.accountFailover && (!cfg.managedPair || !cfg.syncBrowserModes)) throw new Error('A troca individual de conta exige acompanhamento e interfaces sincronizadas.');
  if (cfg.sessionFromParent && !cfg.managedPair) throw new Error('A transferência de sessão exige o acompanhamento ativo.');
  const initialSession = cfg.sessionFromParent ? await waitForSessionInitialization(process, cfg.username) : null;
  const heartbeat = cfg.managedPair ? setInterval(() => {
    if (process.connected) process.send({ type: 'heartbeat' }, () => {});
  }, 10_000) : null;
  heartbeat?.unref();
  const activityBreak = new ActivityBreak(cfg.watch);
  cfg.activityBreak = activityBreak;
  const store = new Store(cfg.dataPath);
  log.info(`Iniciando como @${cfg.username}${cfg.dryRun ? ' [DRY RUN: nada será enviado]' : ''}${watch ? ' [modo contínuo]' : ''}`);
  if (cfg.instance) log.info(`Instância ${cfg.instance}: posts ${cfg.shardIndex + 1}, ${cfg.shardIndex + 3}, ... de ${cfg.profiles.map(profile => `@${profile.username}`).join(', ')}; sessão ${cfg.profilePath}.`);

  for (const p of store.pending()) {
    log.warn(`Comentário ${p.id} de @${p.author}${p.profile ? ` no perfil @${p.profile}` : ''} ficou "pending" em ${p.at} (${p.post}). Não será repetido; confira manualmente.`);
  }

  let { context, page, browserMode } = await openBrowser(cfg);
  if (initialSession) {
    try {
      await context.clearCookies();
      await context.addCookies(initialSession.cookies);
    } catch (error) { await context.close().catch(() => {}); throw error; }
  }
  log.info(`Interface inicial: ${modeLabel(browserMode)}. Conta: @${cfg.username}.`);
  log.info(cfg.syncBrowserModes ? 'A próxima conta e interface serão definidas pelo acompanhamento do par após falhas de leitura.'
    : cfg.mobileFallback && supportsBrowserReadFallback(cfg.username)
    ? `Alternância contínua ${browserReadCycleLabel(cfg.username)} ATIVA para falhas de leitura, mantendo a mesma conta.`
    : 'Alternância de interface desativada nesta execução.');
  if (cfg.syncBrowserModes) log.info('Interface sincronizada com a outra janela: trocas e retomadas são controladas pelo acompanhamento do par.');
  let shuttingDown = false;
  let finishing = false;
  let reopening = false;
  let accountVerified = false;
  const stopSessionExport = cfg.accountFailover ? attachSessionExport(process, async () => {
    if (!accountVerified || shuttingDown || finishing || reopening) throw new Error('Conta não está pronta.');
    return { username: cfg.username, cookies: (await context.cookies()).filter((cookie) =>
      /(^|\.)instagram\.com$/i.test(cookie.domain.replace(/^\./, ''))) };
  }) : () => {};
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownRequested = true;
    log.info('Encerrando a instância; novos envios e ciclos suspensos.');
    await context.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  stopInstance = shutdown;
  const attachBrowserEvents = () => {
    const observedContext = context;
    const unexpectedClose = () => {
      if (finishing || shuttingDown || shutdownRequested || reopening || context !== observedContext) return;
      log.warn(cfg.syncBrowserModes ? 'Janela fechada. Encerrando as duas, sem alternar contas.'
        : cfg.managedPair ? 'Janela fechada. Avisando o acompanhamento para trocar o par.'
        : 'Janela fechada. Encerrando esta instância, sem alternar contas.');
      void shutdown(4);
    };
    page.once('close', unexpectedClose);
    context.once('close', unexpectedClose);
    return monitorRateLimits(context, (details) => {
      log.warn(`HTTP 429 em ${details.path} (${details.visiblePage ? 'navegação principal' : 'requisição interna'}). Retry-After: ${details.retryAfter || 'não informado'}${details.waitMs !== null ? `; espera indicada: ${Math.ceil(details.waitMs / 1000)} segundos` : ''}.`);
    });
  };
  let stopMonitoring = attachBrowserEvents();
  if (process.connected) process.once('disconnect', () => { if (!finishing) void shutdown(); });
  if (shutdownRequested) { await shutdown(); return 0; }

  const verifyAccount = async () => {
    await page.goto(`${IG_URL}${cfg.username}/`, { waitUntil: 'domcontentloaded' });
    await checkForBlock(page);
    if (!(await isLoggedIn(context))) throw new NotLoggedInError('Entre na conta configurada antes de iniciar o servico.');
    await dismissPopups(page);
    const editProfile = page.getByRole('link', { name: /^(Editar perfil|Edit profile)$/i })
      .or(page.getByRole('button', { name: /^(Editar perfil|Edit profile)$/i })).first();
    if (!(await editProfile.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false))) {
      throw new NotLoggedInError(`A sessao nao foi confirmada como @${cfg.username}; nenhum envio iniciado.`);
    }
    log.info(`Sessao verificada: @${cfg.username}.`);
    accountVerified = true;
  };
  let failures = 0;
  let retryPost = null;
  try {
    await verifyAccount();
    if (cfg.managedPair) {
      process.send({ type: 'ready', username: cfg.username, browserMode }, () => {});
      log.info('Aguardando a confirmação da outra janela antes de enviar.');
      const resumed = await pairResumed;
      retryPost = resumed?.retryPost || null;
    }
    for (let cycle = 1; ; cycle++) {
      if (watch) {
        // Relê a configuração a cada ciclo: dá para editar config.json/profiles.json sem reiniciar.
        try {
          const updated = loadConfig();
          configureMessageBank(updated);
          cfg = updated;
        } catch (err) {
          log.warn(`Configuração inválida (${err.message}); mantendo a anterior.`);
        }
        log.info(`--- Ciclo ${cycle} | perfis: ${cfg.profiles.map((p) => `@${p.username}`).join(', ')} ---`);
      }
      activityBreak.configure(cfg.watch);
      cfg.activityBreak = activityBreak;
      cfg.browserMode = browserMode;
      configureClickDelay(page, cfg.delays.beforeClickMs);
      await waitForSchedule(cfg);

      if (!inActiveHours(cfg)) {
        const window = `${cfg.activeHours[0]}h às ${cfg.activeHours[1]}h`;
        if (!watch) {
          log.info(`Fora do horário de funcionamento (${window}). Nada a fazer.`);
          return 0;
        }
        await sleepUntilStart(cfg, `Fora do horário de funcionamento (${window}).`);
        continue;
      }

      let retryWaitMs = 0;
      try {
        const retry = retryPost;
        retryPost = null;
        const ran = await runCycle(context, page, cfg, store, retry);
        retryWaitMs = ran?.retryWaitMs || 0;
        failures = 0;
        if (!watch) return 0;
        if (!ran) {
          await sleepUntilStart(cfg, 'Limite diário atingido.');
          continue;
        }
      } catch (err) {
        if (shutdownRequested) return 0;
        if (err instanceof RetryInBrowserMode) {
          if (cfg.syncBrowserModes) {
            log.warn(err.cause instanceof SendRejectedError && cfg.accountFailover
              ? 'Envios recusados. Solicitando outra conta somente para esta janela; a outra página continua rodando.'
              : `${err.cause instanceof SendRejectedError ? 'Envios recusados' : 'Falha de leitura'}. Solicitando a troca de interface das DUAS janelas; nenhum envio novo nesta instância.`);
            await new Promise((resolve) => process.send({ type: 'read-mode-failure',
              username: cfg.username, browserMode, post: err.post, profile: err.profile,
              failureKind: err.cause instanceof SendRejectedError ? 'send-rejected' : 'read',
              reason: err.cause?.message || err.message }, () => resolve()));
            // O acompanhamento fecha ambos os processos antes de reabrir o par.
            await new Promise(() => {});
          }
          log.warn(`${err.cause instanceof SendRejectedError ? 'Envios recusados' : 'Falha ao ler comentários/respostas'} em ${modeLabel(browserMode)}. Próxima interface: ${modeLabel(err.browserMode)}, na mesma conta @${cfg.username}.`);
          if (err.waitMs > 0) {
            log.info(`Interfaces recusaram leituras consecutivas. Aguardando ${Math.ceil(err.waitMs / 1000)}s antes de alternar novamente.`);
            // Esperas curtas permitem atender encerramentos durante o intervalo.
            const retryAt = Date.now() + err.waitMs;
            while (!shutdownRequested && Date.now() < retryAt) await sleep(Math.min(1000, retryAt - Date.now()));
            if (shutdownRequested) return 0;
          }
          reopening = true;
          stopMonitoring();
          try {
            await context.close();
            if (shutdownRequested) return 0;
            ({ context, page, browserMode } = await openBrowser({ ...cfg, browserMode: err.browserMode }));
            stopMonitoring = attachBrowserEvents();
          } finally {
            reopening = false;
          }
          if (shutdownRequested) { await shutdown(); return 0; }
          await verifyAccount();
          retryPost = { post: err.post, profile: err.profile };
          failures = 0;
          log.info(`${modeLabel(browserMode)} confirmado na mesma conta; histórico mantido. Novas falhas de leitura poderão alternar a interface novamente.`);
          continue;
        }
        if (err instanceof BlockedError || err instanceof NotLoggedInError || err instanceof UncertainSendError) throw err;
        failures++;
        log.error(err.stack || err.message);
        await screenshot(page, 'erro');
        if (!watch) return 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          log.error(`${failures} ciclos seguidos com erro. Parando o serviço.`);
          return 1;
        }
      }

      if (retryWaitMs > 0) {
        if (cfg.managedPair && !cfg.syncBrowserModes) {
          log.warn('Todos os posts encontrados estão indisponíveis após erro. Solicitando a troca conjunta para a outra conta.');
          await new Promise((resolve) => process.send({ type: 'posts-unavailable' }, () => resolve()));
          await shutdown(5);
          return 0;
        }
        log.info(`Todos os posts encontrados estão aguardando nova tentativa após erro. Consultando posts novos em ${Math.ceil(retryWaitMs / 1000)}s; as janelas continuam abertas.`);
        await sleep(retryWaitMs);
      }
      await pause(cfg.watch.intervalMin.map((m) => m * 60), 'até o próximo ciclo');
    }
  } catch (err) {
    if (shutdownRequested) return 0;
    if (err instanceof BlockedError) {
      log.error(`BLOQUEIO/VERIFICAÇÃO: ${err.message}. Parando imediatamente.`);
      await screenshot(page, 'bloqueio');
      return 2;
    }
    if (err instanceof NotLoggedInError) {
      log.error(err.message);
      return 3;
    }
    log.error(err instanceof UncertainSendError ? err.message : (err.stack || err.message));
    if (!(err instanceof UncertainSendError)) await screenshot(page, 'erro');
    return 1;
  } finally {
    finishing = true;
    stopSessionExport();
    clearInterval(heartbeat);
    stopMonitoring();
    await context.close().catch(() => {});
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    log.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
