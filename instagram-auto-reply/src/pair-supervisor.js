import { BrowserReadFallback, RetryInBrowserMode, browserModeLabel, buildAccountModeSequence } from './mobile-fallback.js';
import { CommentsUnavailableError } from './guard.js';
import { validateSessionSnapshot } from './session-transfer.js';

/** Mantém um par de processos sincronizados, sem sobrepor gerações. */
export class PairSupervisor {
  constructor({ accounts, instances, launch, log = console.log, restartMs = 3000,
    stopTimeoutMs = 15_000, heartbeatTimeoutMs = 180_000, killTree = (child) => child.kill('SIGKILL'),
    syncBrowserModes = false, browserMode = null, alternateAccountsByMode = false, instanceAccounts = null,
    accountFailover = false, sessionTimeoutMs = 10_000, accountFirst = false }) {
    if (instanceAccounts && (!syncBrowserModes || alternateAccountsByMode
      || instances.some((instance) => !accounts.includes(instanceAccounts[instance])))) {
      throw new Error('Contas fixas por destino exigem interfaces sincronizadas e uma conta configurada para cada instância.');
    }
    if (accountFailover && !instanceAccounts) throw new Error('A troca individual de conta exige contas por destino.');
    Object.assign(this, { accounts, instances, launch, log, restartMs, stopTimeoutMs, heartbeatTimeoutMs, killTree,
      accountFailover, sessionTimeoutMs, instanceAccounts: instanceAccounts ? { ...instanceAccounts } : null });
    this.children = new Map();
    this.accountIndex = 0;
    this.generation = 0;
    this.failures = 0;
    this.stopped = false;
    this.rotating = false;
    this.syncBrowserModes = syncBrowserModes;
    this.accountFirst = accountFirst;
    this.unavailableAccounts = new Set();
    this.accountModeSequence = alternateAccountsByMode ? buildAccountModeSequence(accounts, accountFirst) : null;
    if (accountFirst && !alternateAccountsByMode) throw new Error('O fluxo por conta exige alternância de contas e dispositivos.');
    this.sequenceIndex = this.accountModeSequence?.findIndex((step) =>
      step.account === accounts[0] && step.browserMode === browserMode) ?? 0;
    if (alternateAccountsByMode && (!syncBrowserModes || this.sequenceIndex < 0)) {
      throw new Error('O fluxo de contas exige interfaces sincronizadas e uma interface inicial válida.');
    }
    this.browserMode = browserMode;
    this.modeFallback = new BrowserReadFallback();
    this.replacements = new Map();
    this.sessionRequests = new Map();
    this.accountFailures = new Map();
    this.requestCounter = 0;
  }

  accountDescription() {
    return this.instanceAccounts
      ? this.instances.map((instance) => `${instance}: @${this.instanceAccounts[instance].username}`).join('; ')
      : `@${this.accounts[this.accountIndex].username}`;
  }

  start() {
    if (this.stopped || this.children.size) return;
    this.rotating = false;
    this.startedAt = Date.now();
    this.generation++;
    this.initialPairReady = false;
    const defaultAccount = this.accounts[this.accountIndex];
    this.generationRetry = this.pendingMode;
    this.pendingMode = null;
    this.log(`Par ${this.generation}: ${this.accountDescription()} em ${this.instances.join(' e ')}.`);
    // Registra ambos antes de receber qualquer evento assíncrono dos filhos.
    for (const instance of this.instances) {
      if (this.rotating || this.stopped) break;
      const account = this.instanceAccounts?.[instance] || defaultAccount;
      try { this.launchInstance(instance, account); }
      catch (err) { this.rotate(`Falha ao iniciar ${instance}: ${err.message}`); break; }
    }
    if (!this.stopped && !this.rotating && this.heartbeatTimeoutMs > 0) {
      this.watchdog = setInterval(() => {
        for (const { instance, ready, replacing, startedAt, lastHeartbeat } of this.children.values()) {
          if (replacing) continue;
          if (Date.now() - lastHeartbeat > this.heartbeatTimeoutMs
            || (!ready && Date.now() - startedAt > this.heartbeatTimeoutMs)) {
            this.rotate(`${instance} deixou de responder ao acompanhamento.`);
            break;
          }
        }
      }, Math.min(15_000, this.heartbeatTimeoutMs));
    }
    this.afterClosed();
  }

  launchInstance(instance, account, { cookies, retryPost } = {}) {
    const child = this.launch(instance, account, { browserMode: this.browserMode,
      ...(cookies ? { sessionFromParent: true } : {}) });
    const state = { instance, account, retryPost, ready: false, resumed: false,
      lastHeartbeat: Date.now(), startedAt: Date.now() };
    this.children.set(child, state);
    child.on('message', (message) => {
      if (!this.children.has(child) || this.stopped || this.rotating) return;
      if (message?.type === 'session-snapshot') {
        const pending = this.sessionRequests.get(message.requestId);
        if (!pending || pending.child !== child) return;
        this.sessionRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        try {
          if (state.replacing || state.sendRejected || message.error) throw new Error('Conta doadora indisponível.');
          pending.resolve(validateSessionSnapshot(message, account.username));
        } catch (error) { pending.reject(error); }
        return;
      }
      if (message?.type === 'heartbeat') state.lastHeartbeat = Date.now();
      if (state.replacing) return;
      if (this.accountFailover && state.ready && message?.type === 'send-success') {
        if (message.username !== account.username || message.browserMode !== this.browserMode) {
          this.rotate(`Conta ou interface inesperada em ${instance}.`); return;
        }
        state.sendRejected = false;
        this.accountFailures.delete(instance);
        return;
      }
      if (this.syncBrowserModes && state.ready && message?.type === 'read-mode-failure') {
        if (this.accountFailover && message.failureKind === 'send-rejected') {
          void this.changeAccount(child, state, account, message).catch(() => this.rotate(`Falha ao trocar a conta em ${instance}.`));
        } else this.changeMode(state, account, message);
        return;
      }
      if (this.syncBrowserModes && state.ready && message?.type === 'read-mode-success') {
        if (message.username !== account.username || message.browserMode !== this.browserMode) {
          this.rotate(`Conta ou interface inesperada em ${instance}.`); return;
        }
        state.readSucceeded = true;
        if (this.children.size === this.instances.length
          && [...this.children.values()].every((s) => s.ready && s.readSucceeded)) this.modeFallback.succeeded();
        return;
      }
      if (message?.type === 'posts-unavailable' && state.ready) {
        this.rotate(`${instance}: todos os posts encontrados ficaram indisponíveis após falhas de leitura/carregamento.`); return;
      }
      if (message?.type !== 'ready') return;
      if (message.username !== account.username || (this.syncBrowserModes && message.browserMode !== this.browserMode)) {
        this.rotate(`Conta inesperada em ${instance}; par suspenso.`); return;
      }
      if (state.ready) return;
      state.ready = true;
      state.lastHeartbeat = Date.now();
      if (this.accountFailover && this.initialPairReady) {
        this.log(`${instance}: @${account.username} confirmado em ${browserModeLabel(this.browserMode)}; retomando somente esta página.`);
        this.resumeWorker(child, state); return;
      }
      if (this.children.size === this.instances.length && [...this.children.values()].every((s) => s.ready)) {
        this.initialPairReady = true;
        const sessionLabel = this.instances.length === 2 ? 'As duas sessões' : `As ${this.instances.length} sessões`;
        this.log(this.instanceAccounts
          ? `${sessionLabel} confirmadas (${this.accountDescription()}). Envios liberados.`
          : `${sessionLabel} confirmadas como @${account.username}. Envios liberados.`);
        if (this.syncBrowserModes) this.log(`${this.instances.length === 2 ? 'As duas' : `As ${this.instances.length}`} janelas em ${browserModeLabel(this.browserMode)}. Envios liberados juntos.`);
        for (const [worker, workerState] of this.children) this.resumeWorker(worker, workerState);
      }
    });
    child.on('error', (err) => this.rotate(`${instance}: ${err.message}`));
    child.once('close', (code, signal) => {
      if (!this.children.has(child)) return;
      this.children.delete(child);
      this.log(`[${instance}] encerrada (${signal || code}).`);
      const plan = this.replacements.get(instance);
      if (!this.stopped && !this.rotating && plan) this.scheduleReplacement(instance, plan);
      else if (!this.stopped && !this.rotating) this.rotate(`Uma janela encerrou: ${instance}.`, true);
      this.afterClosed();
    });
    if (cookies) this.send(child, { type: 'session-init', username: account.username, cookies });
    return child;
  }

  resumeWorker(child, state) {
    if (state.resumed) return;
    state.resumed = true;
    this.send(child, this.syncBrowserModes ? { type: 'resume', retryPost: state.retryPost
      || (this.generationRetry?.instance === state.instance
        ? { post: this.generationRetry.post, profile: this.generationRetry.profile } : null) } : 'resume');
  }

  validFailure(state, account, message) {
    let validPost = false;
    try { validPost = /(^|\.)instagram\.com$/i.test(new URL(message.post?.url).hostname); } catch { /* inválido */ }
    return validPost && message.username === account.username && message.browserMode === this.browserMode
      && message.profile?.username === state.instance.slice(0, -2);
  }

  requestSession(child, state) {
    return new Promise((resolve, reject) => {
      const requestId = `${this.generation}:${++this.requestCounter}`;
      const timer = setTimeout(() => {
        this.sessionRequests.delete(requestId);
        reject(new Error('A conta ativa não disponibilizou a sessão a tempo.'));
      }, this.sessionTimeoutMs);
      this.sessionRequests.set(requestId, { child, resolve, reject, timer });
      this.send(child, { type: 'session-snapshot-request', requestId });
    });
  }

  async changeAccount(child, state, account, message) {
    if (!this.validFailure(state, account, message)) {
      this.rotate(`Solicitação de troca de conta inválida em ${state.instance}.`); return;
    }
    state.replacing = true;
    state.sendRejected = true;
    const failures = (this.accountFailures.get(state.instance) || 0) + 1;
    this.accountFailures.set(state.instance, failures);
    const plan = { generation: this.generation, account, oldChild: child, ready: false,
      retryPost: { post: message.post, profile: message.profile },
      waitMs: Math.min(30 * 60_000, 30_000 * 2 ** Math.min(6, failures - 1)) };
    this.replacements.set(state.instance, plan);
    const donor = [...this.children].find(([worker, candidate]) => worker !== child && candidate.ready
      && !candidate.replacing && !candidate.sendRejected && candidate.account.username !== account.username);
    if (donor) {
      try {
        const snapshot = await this.requestSession(...donor);
        if (this.stopped || this.rotating || this.replacements.get(state.instance) !== plan) return;
        const donorState = this.children.get(donor[0]);
        if (!donorState || donorState.replacing || donorState.sendRejected) throw new Error('A outra conta deixou de estar disponível.');
        plan.account = donorState.account;
        plan.cookies = snapshot.cookies;
        plan.waitMs = 0;
        this.log(`${state.instance}: três recusas de @${account.username}; trocando somente esta janela para @${plan.account.username}. A outra página continua rodando.`);
      } catch {
        if (this.stopped || this.rotating || this.replacements.get(state.instance) !== plan) return;
        this.log(`${state.instance}: sessão da outra conta indisponível; somente esta página aguardará nova tentativa.`);
      }
    } else this.log(`${state.instance}: não há outra conta ativa diferente para assumir; somente esta página aguardará nova tentativa.`);
    plan.ready = true;
    if (!this.children.has(child)) this.scheduleReplacement(state.instance, plan);
    else {
      this.send(child, 'shutdown');
      plan.killTimer = setTimeout(() => { if (this.children.has(child)) this.killTree(child); }, this.stopTimeoutMs);
    }
  }

  scheduleReplacement(instance, plan) {
    if (!plan.ready || plan.restartTimer || this.stopped || this.rotating) return;
    clearTimeout(plan.killTimer);
    this.log(`${instance}: retomando com @${plan.account.username} no mesmo dispositivo em ${Math.ceil(plan.waitMs / 1000)}s.`);
    plan.restartTimer = setTimeout(() => {
      if (this.stopped || this.rotating || this.replacements.get(instance) !== plan || this.generation !== plan.generation) return;
      this.replacements.delete(instance);
      this.instanceAccounts[instance] = plan.account;
      try { this.launchInstance(instance, plan.account, { cookies: plan.cookies, retryPost: plan.retryPost }); }
      catch { this.rotate(`Falha ao iniciar a conta substituta em ${instance}.`); }
    }, plan.waitMs);
  }

  cancelReplacements() {
    for (const plan of this.replacements.values()) { clearTimeout(plan.killTimer); clearTimeout(plan.restartTimer); }
    this.replacements.clear();
    for (const pending of this.sessionRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Troca de conta cancelada.'));
    }
    this.sessionRequests.clear();
  }

  send(child, message) {
    if (!child.connected) return;
    try { child.send(message, () => {}); } catch { /* saída em andamento */ }
  }

  drain() {
    this.cancelReplacements();
    clearInterval(this.watchdog);
    for (const child of this.children.keys()) this.send(child, 'shutdown');
    clearTimeout(this.killTimer);
    if (this.children.size) {
      this.killTimer = setTimeout(() => {
        for (const child of this.children.keys()) this.killTree(child);
      }, this.stopTimeoutMs);
    }
  }

  rotate(reason, accountUnavailable = false) {
    if (this.stopped || this.rotating) return;
    if (this.accountFirst && accountUnavailable) {
      this.unavailableAccounts.add(this.accounts[this.accountIndex]);
      const nextIndex = this.accountModeSequence.findIndex(({ account, browserMode }) =>
        account !== this.accounts[this.accountIndex] && !this.unavailableAccounts.has(account) && browserMode === 'desktop');
      if (nextIndex >= 0) {
        this.rotating = true;
        this.sequenceIndex = nextIndex;
        this.accountIndex = this.accounts.indexOf(this.accountModeSequence[nextIndex].account);
        this.browserMode = 'desktop';
        this.pendingMode = null;
        this.log(`${reason} Fechando AMBAS antes de tentar @${this.accounts[this.accountIndex].username} no desktop.`);
        this.drain();
        this.afterClosed();
        return;
      }
    }
    if (this.syncBrowserModes) {
      this.log(`${reason} Encerrando ${this.instances.length === 2 ? 'as duas' : `as ${this.instances.length}`} janelas; ${this.instanceAccounts ? 'as contas permanecem fixas nos seus destinos' : 'a conta permanece a mesma'}.`);
      this.stop();
      return;
    }
    this.rotating = true;
    this.failures = Date.now() - this.startedAt >= 60_000 ? 0 : this.failures + 1;
    this.accountIndex = (this.accountIndex + 1) % this.accounts.length;
    this.log(`${reason} Fechando o par; próxima conta: @${this.accounts[this.accountIndex].username}.`);
    this.drain();
    this.afterClosed();
  }

  afterClosed() {
    if (this.children.size) return;
    clearTimeout(this.killTimer);
    if (this.stopped || !this.rotating || this.restartTimer) return;
    const wait = this.pendingMode?.waitMs
      ?? Math.min(60_000, this.restartMs * 2 ** Math.min(5, Math.max(0, this.failures - 1)));
    this.log(`Retomando ${this.instances.length === 2 ? 'as duas' : `as ${this.instances.length} janelas`} em ${Math.ceil(wait / 1000)}s.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, wait);
  }

  changeMode(state, account, message) {
    if (!this.validFailure(state, account, message)) {
      this.rotate(`Solicitação de interface inválida em ${state.instance}.`);
      return;
    }
    try {
      this.modeFallback.request(new CommentsUnavailableError(message.reason || 'falha de leitura'), {
        enabled: true, username: account.username, browserMode: this.browserMode,
        post: message.post, profile: message.profile,
      });
    } catch (request) {
      if (!(request instanceof RetryInBrowserMode)) throw request;
      this.rotating = true;
      this.pendingMode = { ...request, instance: state.instance };
      if (this.accountModeSequence) {
        do {
          this.sequenceIndex = (this.sequenceIndex + 1) % this.accountModeSequence.length;
        } while (this.unavailableAccounts.has(this.accountModeSequence[this.sequenceIndex].account));
        const next = this.accountModeSequence[this.sequenceIndex];
        this.accountIndex = this.accounts.indexOf(next.account);
        this.browserMode = next.browserMode;
      } else {
        this.browserMode = request.browserMode;
      }
      this.pendingMode.browserMode = this.browserMode;
      this.log(`${state.instance}: falha de leitura. Pausando e fechando AMBAS para retomar em ${browserModeLabel(this.browserMode)}, com ${this.accountDescription()}.`);
      this.drain();
      this.afterClosed();
      return;
    }
    this.rotate(`Alternância indisponível para @${account.username}.`);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.log(`Acompanhamento encerrado. Fechando ${this.instances.length === 2 ? 'as duas' : `as ${this.instances.length}`} janelas.`);
    this.drain();
  }
}
