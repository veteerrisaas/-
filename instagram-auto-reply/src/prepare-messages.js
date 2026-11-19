import path from 'node:path';
import { loadConfig } from './config.js';
import { MessageBank, loadMessageTemplates, composeMessage } from './message-bank.js';

const cfg = loadConfig();
if (!cfg.messageBank) throw new Error('Ative messageBank.enabled no config.json.');
const templates = loadMessageTemplates(cfg.messageBank.templatesFile);
const bank = new MessageBank(cfg.messageBank.file);
try {
  bank.importHistory(path.dirname(cfg.dataPath));
  console.log(`Banco: ${cfg.messageBank.file}`);
  console.log(`Textos distintos já registrados: ${bank.db.prepare('SELECT COUNT(*) AS n FROM used_messages').get().n}`);
  console.log(`Combinações disponíveis na estrutura: ${templates.size} (antes de descontar as usadas).`);
  for (let i = 0; i < 3; i++) console.log(`Exemplo: ${composeMessage(templates, Math.floor(Math.random() * templates.size))}`);
  console.log('Nenhuma mensagem enviada. Exemplos não foram reservados.');
} finally { bank.close(); }
