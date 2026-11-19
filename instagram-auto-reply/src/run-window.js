export function parseRunWindow(argv, now = Date.now()) {
  const durationFlag = argv.indexOf('--duration-minutes');
  const stopFlag = argv.indexOf('--stop-at');
  if (durationFlag >= 0 && stopFlag >= 0) throw new Error('Escolha duração ou horário de parada, não ambos.');
  const durationMinutes = durationFlag >= 0 ? Number(argv[durationFlag + 1]) : null;
  if (durationFlag >= 0 && (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 60)) {
    throw new Error('Duração deve ser maior que zero e no máximo 60 minutos.');
  }
  let stopAt = null;
  if (stopFlag >= 0) {
    const value = argv[stopFlag + 1] || '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error('--stop-at exige data e hora com fuso, como 2026-11-09T23:00:00-03:00.');
    }
    stopAt = Date.parse(value);
    if (!Number.isFinite(stopAt) || stopAt <= now || stopAt - now > 24 * 60 * 60000) {
      throw new Error('Horário de parada deve estar no futuro, nas próximas 24 horas.');
    }
  }
  return { durationMinutes, stopAt };
}

export function runEndAt(window, now = Date.now()) {
  if (window.stopAt !== null) {
    if (window.stopAt <= now) throw new Error('Horário de parada atingido durante a preparação; serviço não iniciado.');
    return window.stopAt;
  }
  return window.durationMinutes === null ? null : now + window.durationMinutes * 60000;
}
