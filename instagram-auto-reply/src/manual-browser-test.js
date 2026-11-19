import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { ROOT } from './config.js';

const executable = chromium.executablePath();
const profile = path.join(ROOT, 'browser-profile-manual-test');
const testUrl = 'https://www.instagram.com/cazetv/p/DeejWNJFiVT/';
if (!fs.existsSync(executable)) throw new Error('Chromium não instalado. Execute npm run setup.');

if (process.argv.includes('--check')) {
  console.log(`Navegador disponível. Sessão separada: ${profile}. Nenhuma página aberta.`);
} else {
  fs.mkdirSync(profile, { recursive: true });
  console.log('Teste manual: abra os comentários do post. Se necessário, faça login.');
  console.log('Nenhuma automação de comentários iniciada.');
  const browser = spawn(executable, [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--new-window', testUrl,
  ], { stdio: 'ignore' });
  browser.on('error', (err) => { console.error(err.message); process.exitCode = 1; });
  browser.on('exit', (code) => { process.exitCode = code || 0; });
}
