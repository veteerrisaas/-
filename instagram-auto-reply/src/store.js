import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT, readText } from './config.js';
import { localDate, log } from './logger.js';
import { REPORT_FILE, writeReport } from './report.js';

/**
 * Registro local dos comentários respondidos (data/replied.json).
 *
 * Escrita em duas fases: o comentário é gravado como "pending" ANTES de
 * clicar em enviar e vira "sent" depois. Um "pending" nunca é tentado de novo,
 * então o pior caso de uma falha é deixar de responder, nunca responder duas vezes.
 */
export class Store {
  constructor(file, { report = true } = {}) {
    this.file = file;
    this.report = report;
    this.reportFile = path.resolve(file) === path.resolve(PATHS.data) ? REPORT_FILE
      : path.join(ROOT, `relatorio-${path.basename(file, '.json')}.csv`);
    this.refresh();
  }

  refresh() {
    const file = this.file;
    this.data = { version: 1, comments: {} };
    if (fs.existsSync(file)) {
      try {
        this.data = JSON.parse(readText(file));
      } catch (err) {
        // Não sobrescreve um registro corrompido: perder o histórico causaria respostas duplicadas.
        throw new Error(`Registro ${this.file} está corrompido (${err.message}). Corrija ou restaure antes de rodar.`);
      }
    }
  }

  has(commentId) {
    this.refresh();
    return Boolean(this.data.comments[commentId]);
  }

  importHistory(file) {
    if (!fs.existsSync(file) || path.resolve(file) === path.resolve(this.file)) return;
    const previous = new Store(file, { report: false });
    this.withLock(() => {
      this.refresh();
      let changed = false;
      for (const [id, record] of Object.entries(previous.data.comments)) {
        if (this.data.comments[id]) continue;
        this.data.comments[id] = record;
        changed = true;
      }
      if (changed) this.save();
    });
  }

  markPending(commentId, info, maxPerDay = Infinity) {
    return this.withLock(() => {
    this.refresh();
    if (this.has(commentId) || this.countToday() >= maxPerDay) return false;
    this.data.comments[commentId] = {
      status: 'pending',
      ...info,
      day: localDate(),
      at: new Date().toISOString(),
    };
    this.save();
    return true;
    });
  }

  markSent(commentId, extra = {}) {
    return this.withLock(() => {
    this.refresh();
    if (!this.data.comments[commentId]) throw new Error(`Comentário ${commentId} não foi reservado.`);
    Object.assign(this.data.comments[commentId], { status: 'sent', sentAt: new Date().toISOString(), ...extra });
    this.save();
    });
  }

  countToday() {
    this.refresh();
    const today = localDate();
    return Object.values(this.data.comments).filter((c) => c.day === today).length;
  }

  pending() {
    this.refresh();
    return Object.entries(this.data.comments)
      .filter(([, c]) => c.status === 'pending')
      .map(([id, c]) => ({ id, ...c }));
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    // No Windows o rename pode falhar momentaneamente (antivírus/indexador).
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
    try {
      if (this.report) writeReport(this.data, this.reportFile);
    } catch (err) {
      // Normalmente é o CSV aberto no Excel; o registro JSON já foi salvo.
      log.warn(`Não foi possível atualizar o relatório (está aberto no Excel?): ${err.message}`);
    }
  }

  withLock(action) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 5000;
    let handle;
    while (handle === undefined) {
      try { handle = fs.openSync(lock, 'wx'); } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (Date.now() >= deadline) throw new Error(`Registro ocupado: ${lock}. Nenhum envio iniciado.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try { return action(); } finally {
      fs.closeSync(handle);
      fs.unlinkSync(lock);
    }
  }
}
