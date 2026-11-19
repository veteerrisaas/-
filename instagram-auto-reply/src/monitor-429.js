import fs from 'node:fs';
import path from 'node:path';
import { openBrowser } from './browser.js';
import { envSettings, PATHS } from './config.js';

const output = path.join(PATHS.logs, 'monitor-429.log');
const stamp = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const write = (text) => {
  fs.mkdirSync(PATHS.logs, { recursive: true });
  const line = `[${stamp()}] ${text}`;
  fs.appendFileSync(output, `${line}\n`);
  console.log(line);
};

async function main() {
  const settings = envSettings(['--instance', 'cazetv-2']);
  const { context, page } = await openBrowser({ ...settings, instance: null, headless: true });
  let stopping = false;
  const stop = async () => { stopping = true; await context.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Somente o documento: não carrega mídia nem dispara consultas de comentários.
  await context.route('**/*', (route) => route.request().isNavigationRequest()
    ? route.continue() : route.abort());
  write('Monitor iniciado: uma consulta a cada 5 minutos; nenhum envio automático.');
  try {
    while (!stopping) {
      let lastResponse = null;
      const observe = (response) => { if (response.request().isNavigationRequest()) lastResponse = response; };
      page.on('response', observe);
      try {
        await page.goto('https://www.instagram.com/p/DeeaepmDbmU/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (!lastResponse) write(`Consulta inconclusiva: ${err.message.split('\n')[0]}`);
      } finally { page.off('response', observe); }
      if (lastResponse) {
        const status = lastResponse.status();
        const headers = await lastResponse.allHeaders();
        write(`HTTP ${status}; Retry-After: ${headers['retry-after'] || 'não informado'}.`);
        if (status === 200 && new URL(lastResponse.url()).pathname === '/p/DeeaepmDbmU/') {
          write('O acesso ao post voltou a responder HTTP 200. Monitor encerrado; auto-reply não iniciado.');
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
    }
  } finally { await context.close().catch(() => {}); }
}

main().catch((err) => { write(`Monitor encerrado com erro: ${err.message}`); process.exitCode = 1; });
