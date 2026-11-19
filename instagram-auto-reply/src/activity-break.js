import { performance } from 'node:perf_hooks';
import { sleep } from './human.js';
import { log } from './logger.js';

/** Mantém a janela de trabalho entre ciclos; a pausa ocorre antes de um novo envio. */
export class ActivityBreak {
  constructor(options, { now = () => performance.now(), wait = sleep, logger = log, random = Math.random } = {}) {
    this.now = now;
    this.wait = wait;
    this.logger = logger;
    this.random = random;
    this.startedAt = now();
    this.configure(options);
  }

  configure({ workSessionMin, breakMin }) {
    this.workMs = workSessionMin * 60_000;
    this.breakRange = Array.isArray(breakMin) ? breakMin : [breakMin, breakMin];
  }

  async waitIfDue() {
    if (this.now() - this.startedAt < this.workMs) return false;
    const [min, max] = this.breakRange;
    const breakMs = (min + this.random() * (max - min)) * 60_000;
    this.logger.info(`Pausa periódica: ${this.workMs / 60_000} min de execução; aguardando ${(breakMs / 60_000).toFixed(2)} min sem enviar (sorteio entre ${min} e ${max} min).`);
    await this.wait(breakMs);
    this.startedAt = this.now();
    this.logger.info('Pausa periódica concluída; retomando a verificação.');
    return true;
  }
}
