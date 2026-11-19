// Bloqueios explícitos continuam valendo mesmo se a legenda for alterada.
const BLOCKED_POST_CODES = new Set(['DfibQK8jYr3']);
const codeFromUrl = (url) => {
  try { return new URL(url).pathname.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/)?.[1]; }
  catch { return null; }
};

export function mourningReason(text) {
  const normalized = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    // Expressões esportivas não indicam falecimento por si só.
    .replace(/\b(?:grupo da morte|morte subita|morreu (?:o lance|a jogada|a chance))\b/g, '');
  const rules = [
    [/\b(?:luto|falecimento|faleceu|falecid[oa]s?|obito|funeral|velorio|sepultamento|enterro)\b/, 'luto ou falecimento'],
    [/\b(?:morreu|morreram|morte|morto|morta|mortos|mortas|assassinat[oa]|suicidio)\b/, 'notícia de morte'],
    [/\b(?:pesames|condolencias|nota de pesar|profundo pesar|meus sentimentos|nossos sentimentos)\b/, 'condolências'],
    [/\b(?:descanse(?:m)? em paz|descanse(?:m)? em poder|saudosa memoria|em memoria de|homenagem postuma)\b/, 'homenagem póstuma'],
    [/\b(?:passed away|rest in peace|rip|condolences|in loving memory|mourning|death|died|funeral)\b/, 'luto em inglês'],
    [/\b(?:momento de dor|momento de perda|forca (?:aos|as) familiares)\b/, 'mensagem de pesar'],
  ];
  return rules.find(([pattern]) => pattern.test(normalized))?.[1] || null;
}

/** Avalia somente o post exato, sem usar textos dos comentários ou sugestões. */
export async function inspectPostSafety(page, postCode = codeFromUrl(page.url())) {
  if (BLOCKED_POST_CODES.has(postCode)) return { safe: false, reason: 'post de luto bloqueado explicitamente' };
  if (!postCode || codeFromUrl(page.url()) !== postCode) {
    return { safe: false, reason: 'não foi possível identificar o post para verificar luto' };
  }
  const { captions, imageTexts } = await page.evaluate((code) => {
    const captions = new Set();
    const imageTexts = new Set();
    const add = (set, text) => { if (typeof text === 'string' && text.trim()) set.add(text.trim()); };
    const inspectMedia = (media) => {
      if (media.code !== code && media.shortcode !== code) return;
      add(captions, typeof media.caption === 'string' ? media.caption : media.caption?.text);
      for (const edge of media.edge_media_to_caption?.edges || []) add(captions, edge.node?.text);
      add(imageTexts, media.accessibility_caption);
      for (const image of media.carousel_media || []) add(imageTexts, image.accessibility_caption);
    };
    const seen = new WeakSet();
    let visited = 0;
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 15 || visited++ > 30000
        || seen.has(value) || value instanceof Node) return;
      seen.add(value);
      inspectMedia(value);
      for (const [key, child] of Object.entries(value)) {
        if (!['return', 'child', 'sibling', 'alternate', 'stateNode', '_owner'].includes(key)) walk(child, depth + 1);
      }
    };
    const scope = document.querySelector('main') || document.querySelector('article');
    if (scope) {
      for (const element of [scope, ...[...scope.querySelectorAll('*')].slice(0, 250)]) {
        const keys = Object.keys(element);
        const propsKey = keys.find(key => key.startsWith('__reactProps$'));
        if (propsKey) walk(element[propsKey]);
        const fiberKey = keys.find(key => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? element[fiberKey] : null;
        for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) walk(fiber.memoizedProps);
      }
      for (const heading of scope.querySelectorAll('h1')) {
        if (!heading.closest('[data-ar-comment]') && heading.getClientRects().length) add(captions, heading.innerText);
      }
      for (const image of scope.querySelectorAll('article img[alt]')) {
        if (!image.closest('header, li, [data-ar-comment]')) add(imageTexts, image.getAttribute('alt'));
      }
    }
    visited = 0;
    for (const script of document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')) {
      const text = script.textContent || '';
      if (text.length > 3000000 || !text.includes(code)) continue;
      try {
        const data = JSON.parse(text);
        walk(data);
        // JSON-LD só é usado quando a URL pertence ao post atual.
        const entries = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
        for (const entry of entries) {
          if (entry && typeof entry === 'object' && typeof entry.url === 'string'
            && entry.url.match(/\/(?:p|reel)\/([^/]+)/)?.[1] === code) add(captions, entry.description);
        }
      } catch { /* Dados desconhecidos não liberam o post. */ }
    }
    const metaUrl = document.querySelector('meta[property="og:url"]')?.content || '';
    if (metaUrl.match(/\/(?:p|reel)\/([^/]+)/)?.[1] === code) {
      add(captions, document.querySelector('meta[property="og:description"]')?.content);
    }
    return { captions: [...captions], imageTexts: [...imageTexts] };
  }, postCode);
  for (const text of [...captions, ...imageTexts]) {
    const reason = mourningReason(text);
    if (reason) return { safe: false, reason };
  }
  if (!captions.length) return { safe: false, reason: 'legenda indisponível para verificar conteúdo de luto' };
  return { safe: true, reason: null };
}
