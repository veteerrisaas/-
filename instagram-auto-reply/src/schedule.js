import { sleep } from './human.js';
import { log } from './logger.js';

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo', hourCycle: 'h23',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function inQuietHours(quietHours, now = new Date()) {
  if (quietHours === false) return false;
  const [start, end] = quietHours;
  const parts = Object.fromEntries(clock.formatToParts(now).map(p => [p.type, p.value]));
  const hour = Number(parts.hour) + Number(parts.minute) / 60 + Number(parts.second) / 3600;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export async function waitForSchedule(cfg) {
  if (!inQuietHours(cfg.quietHours)) return;
  log.info(`Pausa diaria: ${cfg.quietHours[0]}h ate ${cfg.quietHours[1]}h (America/Sao_Paulo); envios suspensos.`);
  while (inQuietHours(cfg.quietHours)) await sleep(1000);
  // A pausa noturna substitui a pausa periodica que estaria vencida.
  cfg.activityBreak.startedAt = cfg.activityBreak.now();
  log.info('Pausa diaria concluida; retomando os envios.');
}
