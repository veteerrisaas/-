/** Contagens abreviadas usam o limite inferior do arredondamento exibido. */
export function parseCommentCount(text) {
  const match = String(text).trim().toLowerCase().match(/^([\d.,\s]+)\s*(k|mil|m|milh[oõ]es?|million)?$/);
  if (!match) return null;
  const number = match[1].replace(/\s/g, '');
  if (!match[2]) {
    if (!/^\d+$/.test(number) && !/^\d{1,3}(?:[.,]\d{3})+$/.test(number)) return null;
    const value = Number(number.replace(/[.,]/g, ''));
    return Number.isSafeInteger(value) ? value : null;
  }
  if (!/^\d+(?:[.,]\d+)?$/.test(number)) return null;
  const value = Number(number.replace(',', '.'));
  const decimals = number.split(/[.,]/)[1]?.length || 0;
  const scale = /^(k|mil)$/.test(match[2]) ? 1000 : 1000000;
  return Math.max(0, Math.floor(value * scale - scale / (2 * 10 ** decimals)));
}

/** Lê apenas o contador ao lado do ícone de comentários ou um rótulo de total. */
export async function getPostCommentCount(page) {
  const candidates = await page.evaluate(() => {
    const out = [];
    for (const icon of document.querySelectorAll('svg[aria-label]')) {
      if (!/^(Comment|Comments|Comentar|Coment[aá]rios?)$/i.test(icon.getAttribute('aria-label') || '')) continue;
      if (!icon.getClientRects().length) continue;
      for (let parent = icon.parentElement, depth = 0;
        parent && depth < 4; parent = parent.parentElement, depth++) {
        const sibling = parent.nextElementSibling;
        if (sibling && !sibling.querySelector('svg')) out.push(sibling.textContent.trim());
      }
    }
    for (const element of document.querySelectorAll('a, button, [role="button"]')) {
      if (!element.getClientRects().length || element.closest('[data-ar-comment], li')) continue;
      const match = element.textContent.trim().match(/^(?:View all|Ver todos os)\s+([\d.,\s]+(?:k|mil|m)?)\s+(?:comments|coment[aá]rios)$/i);
      if (match) out.push(match[1]);
    }
    return out;
  });
  for (const candidate of candidates) {
    const count = parseCommentCount(candidate);
    if (count !== null) return count;
  }
  return null;
}
