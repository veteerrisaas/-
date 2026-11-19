const codeFromUrl = (url) => new URL(url).pathname.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/)?.[1];

/** Lê a autoria do post exato; menções, marcações e comentários não são coautores. */
export async function inspectPostCollaboration(page, postCode = codeFromUrl(page.url())) {
  const currentCode = codeFromUrl(page.url());
  if (!postCode || currentCode !== postCode) return { status: 'unknown', authors: [] };
  return page.evaluate((code) => {
    const authors = new Set();
    let solo = false;
    let collab = false;
    const normalize = (value) => typeof value === 'string' && /^[a-z0-9._]{1,30}$/i.test(value)
      ? value.toLowerCase() : null;
    const author = (user) => normalize(user?.username);
    const addAuthor = (username) => { if (username) authors.add(username); };
    const inspectMedia = (media) => {
      if (media.code !== code && media.shortcode !== code) return;
      const owner = author(media.user) || author(media.owner);
      const coauthors = media.coauthor_producers;
      if (Array.isArray(coauthors)) {
        addAuthor(owner);
        for (const user of coauthors) addAuthor(author(user));
        if (coauthors.length) collab = true;
        else if (owner) solo = true;
      }
      if (media.is_collab === true) { collab = true; addAuthor(owner); }
      if (media.is_collab === false && owner) { solo = true; addAuthor(owner); }
    };

    const seen = new WeakSet();
    let visited = 0;
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 15 || visited++ > 30_000
        || seen.has(value) || value instanceof Node) return;
      seen.add(value);
      inspectMedia(value);
      // Evita percorrer a árvore React inteira ou referências ao DOM.
      for (const [key, child] of Object.entries(value)) {
        if (!['return', 'child', 'sibling', 'alternate', 'stateNode', '_owner'].includes(key)) walk(child, depth + 1);
      }
    };
    const scope = document.querySelector('main') || document.querySelector('article');
    if (!scope) return { status: 'unknown', authors: [] };
    for (const element of [scope, ...[...scope.querySelectorAll('*')].slice(0, 250)]) {
      const keys = Object.keys(element);
      const propsKey = keys.find((key) => key.startsWith('__reactProps$'));
      if (propsKey) walk(element[propsKey]);
      const fiberKey = keys.find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? element[fiberKey] : null;
      for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) walk(fiber.memoizedProps);
    }
    // Algumas interfaces entregam os dados antes de hidratar a árvore React.
    if (!collab && !solo) {
      visited = 0;
      for (const script of document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')) {
        const text = script.textContent || '';
        if (text.length > 3_000_000 || !text.includes(code)) continue;
        try { walk(JSON.parse(text)); } catch { /* Formato desconhecido: não libera o post. */ }
      }
    }
    // O cabeçalho também identifica uma collab quando a lista está visível ou recolhida.
    // Links na legenda, nos comentários e na seção de sugestões ficam fora dessa leitura.
    const article = scope.matches('article') ? scope : scope.querySelector('article');
    const headers = !collab && !solo ? [...(article || scope).querySelectorAll('header')]
      .filter((header) => header.getClientRects().length && !header.closest('li, [data-ar-comment]')).slice(0, 1) : [];
    for (const header of headers) {
      if (!header.getClientRects().length || header.closest('li, [data-ar-comment]')) continue;
      const headerAuthors = new Set();
      for (const link of header.querySelectorAll('a[href]')) {
        const path = new URL(link.getAttribute('href'), location.origin).pathname;
        const match = path.match(/^\/(?:_u\/)?([a-z0-9._]{1,30})\/?$/i);
        if (!match || /^(accounts|direct|explore|reels?|p|stories|about|legal)$/i.test(match[1])) continue;
        headerAuthors.add(match[1].toLowerCase());
      }
      const headerTexts = [header.innerText,
        ...[...header.querySelectorAll('button, [role="button"]')].map((control) => control.innerText)];
      const hiddenAuthors = headerTexts.some((text) =>
        /\b(?:e|and)\s+(?:mais\s+)?(?:\d+\s+)?(?:outras?|outros?|others?)\b/i.test(text));
      if (headerAuthors.size > 1 || (headerAuthors.size && hiddenAuthors)) {
        collab = true;
        for (const username of headerAuthors) addAuthor(username);
      }
    }
    return { status: collab ? 'collab' : solo ? 'solo' : 'unknown', authors: [...authors] };
  }, postCode);
}
