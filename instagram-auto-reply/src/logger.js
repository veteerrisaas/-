import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

const pad = (n) => String(n).padStart(2, '0');

/** Data local no formato AAAA-MM-DD (usada no nome do log e no limite diário). */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, msg) {
  const instance = process.env.IG_INSTANCE_LABEL;
  const line = `[${localDate()} ${localTime()}] ${level.padEnd(5)} ${instance ? `[${instance}] ` : ''}${msg}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    fs.appendFileSync(path.join(PATHS.logs, `${localDate()}.log`), `${line}\n`);
  } catch {
    // Falha ao gravar o log em disco não deve derrubar a execução.
  }
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  dry: (m) => write('DRY', m),
};

export async function screenshot(page, label) {
  try {
    fs.mkdirSync(PATHS.screenshots, { recursive: true });
    const stamp = `${localDate()}_${localTime().replaceAll(':', '')}`;
    const file = path.join(PATHS.screenshots, `${stamp}_${label.replace(/[^\w-]+/g, '_')}.png`);
    await page.screenshot({ path: file });
    log.info(`Screenshot salvo: ${file}`);
    return file;
  } catch (err) {
    log.warn(`Não foi possível salvar screenshot: ${err.message}`);
    return null;
  }
}
