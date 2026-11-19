/** Associa a consulta de respostas ao pai exato, preservando IDs grandes. */
export function replyReadTargets(request, commentId) {
  const parse = (text) => JSON.parse(text.replace(
    /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => /^\d{16,}$/.test(token) ? `"${token}"` : token,
  ));
  const body = request.postData() || '';
  let value;
  try { value = parse(body); } catch {
    const variables = new URLSearchParams(body).get('variables');
    try { value = parse(variables || 'null'); } catch { return false; }
  }
  const ids = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 15) return;
    for (const [key, child] of Object.entries(node)) {
      if (/^(?:comment_id|commentId|commentID|parent_comment_id|root_comment_id)$/.test(key)) {
        ids.push(typeof child === 'string' ? child : Number.isSafeInteger(child) ? String(child) : null);
      } else if (typeof child === 'object') visit(child, depth + 1);
      else if (key === 'variables' && typeof child === 'string') {
        try { visit(parse(child), depth + 1); } catch { /* Consulta desconhecida. */ }
      }
    }
  };
  visit(value);
  return ids.length > 0 && ids.every((id) => id === String(commentId));
}

/** Só confirma respostas vazias quando a consulta conhecida terminou sem paginação. */
export function inspectReplyRead(body, httpStatus) {
  const errors = [];
  const collections = [];
  let visited = 0;
  let truncated = false;
  const visit = (value, key = '', depth = 0) => {
    if (!value || typeof value !== 'object') return;
    if (depth > 25 || visited++ > 20_000) { truncated = true; return; }
    if (Array.isArray(value.errors) && value.errors.length) {
      errors.push(...value.errors.map((error) => String(error?.message || error?.description || 'erro de leitura')));
    }
    if (value.errors && !Array.isArray(value.errors)) errors.push('erro de leitura desconhecido');
    if (value.status === 'fail') errors.push(String(value.message || value.error_type || 'falha de leitura'));
    if (/child_?comments|comment_?replies|^replies$/i.test(key)) {
      if (Array.isArray(value.edges)) {
        collections.push({ nodes: value.edges.map((edge) => edge?.node),
          complete: value.page_info?.has_next_page === false && value.page_info?.has_previous_page !== true });
      } else if (Array.isArray(value.child_comments)) {
        const flags = ['has_more_child_comments', 'has_more_tail_child_comments', 'has_more_head_child_comments']
          .map((name) => value[name]).filter((flag) => typeof flag === 'boolean');
        collections.push({ nodes: value.child_comments, complete: flags.length > 0 && flags.every((flag) => flag === false) });
      }
    }
    for (const [name, child] of Object.entries(value)) visit(child, name, depth + 1);
  };
  visit(body);
  const limited = httpStatus === 429 || errors.some((error) => /rate.?limit|too many requests/i.test(error));
  const confirmed = httpStatus >= 200 && httpStatus < 300 && errors.length === 0
    && collections.length > 0 && !truncated;
  const nodes = collections.flatMap((collection) => collection.nodes);
  const authors = nodes.map((node) => node?.user?.username || node?.owner?.username || null)
    .map((name) => typeof name === 'string' ? name.trim().replace(/^@/, '').toLowerCase() : null);
  const complete = confirmed && collections.every((collection) => collection.complete)
    && authors.every((name) => /^[a-z0-9._]{1,30}$/.test(name || ''));
  return { confirmed, complete, empty: confirmed && nodes.length === 0, limited,
    authors: [...new Set(authors.filter(Boolean))] };
}
