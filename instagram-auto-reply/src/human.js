import { log } from './logger.js';

export const rand = (min, max) => min + Math.random() * (max - min);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clickDelays = new WeakMap();
export const configureClickDelay = (page, range = [0, 0]) => clickDelays.set(page, range);
export async function beforeClick(page) {
  const [min, max] = clickDelays.get(page) ?? [0, 0];
  if (max > 0) await sleep(rand(min, max));
}
export async function humanClick(page, target, options) {
  await beforeClick(page);
  return target.click(options);
}

/** Pausa aleatória em segundos, ex.: pause([20, 60], 'entre respostas'). */
export async function pause([minSec, maxSec], label) {
  const ms = rand(minSec * 1000, maxSec * 1000);
  if (ms <= 0) return;
  if (label) log.info(`Pausa de ${Math.round(ms / 1000)}s (${label})`);
  await sleep(ms);
}

/** Pausa curta entre cliques, como uma pessoa faria. */
export const shortPause = () => process.argv.includes('--no-action-delays') ? Promise.resolve() : sleep(rand(600, 1800));

const segmenter = new Intl.Segmenter();

/**
 * Digita no elemento focado caractere a caractere (por grafema, para não
 * quebrar emojis compostos). Ritmos acima de 20ms têm hesitações ocasionais.
 */
export async function humanType(page, text, [minMs, maxMs]) {
  for (const { segment } of segmenter.segment(text)) {
    await page.keyboard.type(segment);
    await sleep(rand(minMs, maxMs));
    if (maxMs > 20 && Math.random() < 0.05) await sleep(rand(300, 900));
  }
}
