import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunWindow, runEndAt } from '../src/run-window.js';

const now = Date.parse('2026-11-09T20:00:00-03:00');
test('parada às 23h de Brasília permanece fixa após a preparação e retomadas', () => {
  const window = parseRunWindow(['--stop-at', '2026-11-09T23:00:00-03:00'], now);
  const expected = Date.parse('2026-11-10T02:00:00Z');
  assert.equal(runEndAt(window, now), expected);
  assert.equal(runEndAt(window, now + 45 * 60000), expected);
  assert.throws(() => runEndAt(window, expected), /não iniciado/);
});
test('horários inválidos, vencidos e sem fuso não iniciam execução', () => {
  for (const value of ['', '23:00', '2026-11-09T23:00:00', '2026-11-09T19:00:00-03:00',
    '2026-11-11T23:00:00-03:00', '2026-11-09T99:00:00-03:00']) {
    assert.throws(() => parseRunWindow(['--stop-at', value], now), undefined, value);
  }
});
test('testes por duração preservam seu tempo e não aceitam duas formas de limite', () => {
  const window = parseRunWindow(['--duration-minutes', '5'], now);
  assert.equal(runEndAt(window, now + 10000), now + 10000 + 5 * 60000);
  assert.equal(runEndAt(parseRunWindow([], now), now), null);
  assert.throws(() => parseRunWindow(['--duration-minutes', '5', '--stop-at', '2026-11-09T23:00:00-03:00'], now));
  for (const value of ['0', '-1', 'NaN', '61']) assert.throws(() => parseRunWindow(['--duration-minutes', value], now));
});
