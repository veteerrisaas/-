export const RESTART_DELAYS_MS = [15, 30, 60, 120].map((minutes) => minutes * 60_000);

/** Reinicia o acompanhamento inteiro, sempre com os mesmos argumentos iniciais. */
export class ServiceRestart {
  constructor({ launch, log = console.log, killTree = (child) => child.kill(),
    schedule = setTimeout, cancel = clearTimeout, now = Date.now, stopTimeoutMs = 30_000 }) {
    Object.assign(this, { launch, log, killTree, schedule, cancel, now, stopTimeoutMs });
    this.failures = 0;
    this.stopped = false;
    this.child = null;
    this.timer = null;
    this.killTimer = null;
  }

  start() {
    if (this.stopped || this.child || this.timer !== null) return;
    try {
      const child = this.launch();
      this.child = child;
      child.on('error', (error) => this.log(`Falha no acompanhamento: ${error.message}`));
      child.once('close', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        this.cancel(this.killTimer);
        this.killTimer = null;
        if (!this.stopped) this.retry(`Acompanhamento encerrou (${signal || code}).`);
      });
      this.log('Serviço iniciado do começo, com as contas e o dispositivo iniciais.');
    } catch (error) {
      this.retry(`Falha ao iniciar: ${error.message}`);
    }
  }

  retry(reason) {
    if (this.stopped || this.timer !== null) return;
    const waitMs = RESTART_DELAYS_MS[Math.min(this.failures++, RESTART_DELAYS_MS.length - 1)];
    const resumeAt = new Date(this.now() + waitMs).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    this.log(`${reason} Pausa de ${waitMs / 60_000} minutos. Nova tentativa do início: ${resumeAt} (Brasília).`);
    this.timer = this.schedule(() => {
      this.timer = null;
      this.start();
    }, waitMs);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancel(this.timer);
    this.timer = null;
    this.log('Serviço parado manualmente; retomadas automáticas canceladas.');
    const child = this.child;
    if (!child) return;
    this.killTimer = this.schedule(() => {
      if (this.child === child) this.killTree(child);
    }, this.stopTimeoutMs);
    try {
      if (child.connected) child.send('shutdown', () => {});
      else child.kill('SIGTERM');
    } catch { this.killTree(child); }
  }
}
