// Gera relatorio-respostas.csv a partir de data/replied.json.
// É atualizado sozinho a cada resposta; `npm run report` gera de novo manualmente.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PATHS, ROOT, readText } from './config.js';

export const REPORT_FILE = path.join(ROOT, 'relatorio-respostas.csv');

const COLUMNS = [
  ['Respondido em', (c) => fmt(c.sentAt || c.at)],
  ['Perfil', (c) => (c.profile ? `@${c.profile}` : '')],
  ['Link do post', (c) => c.post],
  ['Link do comentário', (c) => c.commentUrl],
  ['Quem comentou', (c) => `@${c.author}`],
  ['Comentário', (c) => c.comment],
  ['Comentado em', (c) => fmt(c.commentedAt)],
  ['Resposta enviada', (c) => c.reply],
  ['Status', (c) => STATUS[c.status === 'sent' && c.verified === false ? 'unverified' : c.status] ?? c.status],
];

const STATUS = {
  sent: 'enviado',
  unverified: 'enviado (não verificado)',
  pending: 'pendente (conferir manualmente)',
};

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '';
}

function cell(value) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ');
  return /[";]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Escreve o CSV (separador ";" e BOM UTF-8, para abrir certo no Excel em português). */
export function writeReport(data, outputFile = REPORT_FILE) {
  const rows = Object.values(data.comments)
    .sort((a, b) => Date.parse(b.sentAt || b.at) - Date.parse(a.sentAt || a.at))
    .map((c) => COLUMNS.map(([, get]) => cell(get(c))).join(';'));
  const csv = `﻿${[COLUMNS.map(([name]) => name).join(';'), ...rows].join('\r\n')}\r\n`;
  fs.writeFileSync(outputFile, csv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = fs.existsSync(PATHS.data)
    ? JSON.parse(readText(PATHS.data))
    : { comments: {} };
  writeReport(data);
  console.log(`Relatório gerado: ${REPORT_FILE} (${Object.keys(data.comments).length} respostas)`);
}
