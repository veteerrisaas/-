import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Menções, pontuação e emojis não tornam uma mensagem inédita.
export function normalizeMessage(text) {
  return String(text).replace(/^\s*@[a-z0-9._]+\s+/i, '')
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const fingerprint = (text) => createHash('sha256').update(normalizeMessage(text)).digest('hex');

export function loadMessageTemplates(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const slots = ['openings', 'audiences', 'bridges', 'closings'].map((name) => {
    if (name === 'closings' && raw[name] === undefined) return [''];
    if (!Array.isArray(raw[name]) || !raw[name].length
      || raw[name].some((text) => typeof text !== 'string' || !text.trim())) {
      throw new Error(`Banco de mensagens: lista "${name}" inválida.`);
    }
    return [...new Set(raw[name].map((text) => text.trim()))];
  });
  const size = slots.reduce((total, slot) => total * slot.length, 1);
  if (!Number.isSafeInteger(size) || size > 200_000) {
    throw new Error('Banco de mensagens: limite de 200.000 combinações excedido.');
  }
  if (raw.maxLength !== undefined && (!Number.isInteger(raw.maxLength) || raw.maxLength < 1)) {
    throw new Error('Banco de mensagens: maxLength deve ser um inteiro positivo.');
  }
  return { slots, size, suffix: typeof raw.suffix === 'string' ? raw.suffix.trim() : '',
    maxLength: raw.maxLength ?? Infinity, impactOpening: raw.impactOpening === true };
}

export function fitsMessageRules(text, templates) {
  return (!templates || text.length <= templates.maxLength || templates.maxLength === undefined)
    && (!templates?.impactOpening || /^\p{Lu}[\p{Lu}\p{M}]*!\s/u.test(text));
}

export function composeMessage(templates, index) {
  const parts = [];
  for (const slot of templates.slots) {
    parts.push(slot[index % slot.length]);
    index = Math.floor(index / slot.length);
  }
  return [...parts, templates.suffix].filter(Boolean).join(' ');
}

export class MessageBank {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout = 10000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS used_messages (
        fingerprint TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL,
        reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS send_pacing (account TEXT PRIMARY KEY, next_at INTEGER NOT NULL);`);
    this.insert = this.db.prepare('INSERT OR IGNORE INTO used_messages (fingerprint, text, source) VALUES (?, ?, ?)');
  }

  close() { this.db.close(); }

  // Importa também os pendentes: um envio incerto nunca libera o mesmo texto.
  importHistory(directory) {
    for (const file of fs.readdirSync(directory).filter((name) => /^replied.*\.json$/.test(name))) {
      const key = `history-v1:${file}`;
      if (this.db.prepare('SELECT 1 FROM metadata WHERE key = ?').get(key)) continue;
      const history = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8').replace(/^\uFEFF/, ''));
      if (!history.comments || typeof history.comments !== 'object' || Array.isArray(history.comments)) {
        throw new Error(`Histórico inválido: ${file}. Nenhum envio iniciado.`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.db.prepare('SELECT 1 FROM metadata WHERE key = ?').get(key)) {
          for (const entry of Object.values(history.comments)) {
            if (entry.reply && normalizeMessage(entry.reply)) this.insert.run(fingerprint(entry.reply), entry.reply, 'history');
          }
          this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  reserve(messages, templates, { preview = false } = {}) {
    const claim = (text, source) => {
      if (!fitsMessageRules(text, templates)) return false;
      if (!normalizeMessage(text)) return false;
      if (preview) return !this.db.prepare('SELECT 1 FROM used_messages WHERE fingerprint = ?').get(fingerprint(text));
      return this.insert.run(fingerprint(text), text, source).changes === 1;
    };
    const start = randomInt(messages.length);
    for (let i = 0; i < messages.length; i++) {
      const text = messages[(start + i) % messages.length];
      if (claim(text, 'configured')) return text;
    }
    if (templates) {
      const startIndex = randomInt(templates.size);
      for (let i = 0; i < templates.size; i++) {
        const text = composeMessage(templates, (startIndex + i) % templates.size);
        if (claim(text, 'generated')) return text;
      }
    }
    return null; // Esgotamento suspende novos envios; não recicla mensagens.
  }

  // Transação curta: somente uma janela da mesma conta recebe a vez.
  claimSendSlot(account, [min, max], now = Date.now(), random = Math.random) {
    if (min === 0 && max === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.db.prepare('SELECT next_at FROM send_pacing WHERE account = ?').get(account)?.next_at || 0;
      if (next > now) {
        this.db.exec('COMMIT');
        return next - now;
      }
      const delay = Math.ceil((min + random() * (max - min)) * 1000);
      this.db.prepare(`INSERT INTO send_pacing (account, next_at) VALUES (?, ?)
        ON CONFLICT(account) DO UPDATE SET next_at = excluded.next_at`).run(account, now + delay);
      this.db.exec('COMMIT');
      return 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
