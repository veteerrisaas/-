import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

/** Reserva um horário global para navegações das quatro sessões. */
export function reserveNavigation(file = path.join(PATHS.logs, 'navigation-slot.json'), now = Date.now(), interval = [3000, 5000]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let handle;
  while (handle === undefined) {
    try { handle = fs.openSync(lock, 'wx'); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error('Fila de navegação ocupada; nenhuma nova página aberta.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const next = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).next : 0;
    if (!Number.isFinite(next)) throw new Error('Fila de navegação inválida.');
    const slot = Math.max(now, next);
    fs.writeFileSync(file, JSON.stringify({ next: slot + interval[0] + Math.random() * (interval[1] - interval[0]) }));
    return slot;
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}
