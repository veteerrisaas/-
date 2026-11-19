/** Adia somente o endereço que falhou e permite descobrir posts novos. */
export class PostRetryQueue {
  constructor({ retryMs = 30 * 60_000, pollMs = 60_000 } = {}) {
    this.retryMs = retryMs;
    this.pollMs = pollMs;
    this.posts = new Map();
  }

  defer(url, reason, now = Date.now()) {
    this.posts.set(url, { reason, retryAt: now + this.retryMs });
  }

  get(url, now = Date.now()) {
    const entry = this.posts.get(url);
    if (entry && entry.retryAt > now) return entry;
    this.posts.delete(url);
    return null;
  }

  idleWait(urls, now = Date.now()) {
    if (!urls.length) return 0;
    const pending = urls.map((url) => this.get(url, now));
    if (pending.some((entry) => !entry)) return 0;
    // Descobre posts novos a cada minuto, ou antes se um endereço já puder retomar.
    return Math.min(this.pollMs, ...pending.map((entry) => entry.retryAt - now));
  }
}
