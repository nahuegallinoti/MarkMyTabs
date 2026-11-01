// Búsqueda sin dependencias del DOM: la usan las páginas y el service worker (omnibox).

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normalize(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

export function tokenize(query) {
  return normalize(query).split(/\s+/).filter(Boolean);
}

// Puntúa un nodo contra los tokens; devuelve -1 si no matchea todos
export function searchScore(node, tokens, path = '') {
  const title = normalize(node.title || '');
  const url = normalize(node.url || '');
  const domain = node.url ? normalize(domainOf(node.url)) : '';
  const folderPath = normalize(path);
  let score = 0;
  for (const t of tokens) {
    const it = title.indexOf(t);
    const iu = url.indexOf(t);
    if (it === -1 && iu === -1 && !folderPath.includes(t)) return -1;
    if (folderPath.includes(t)) score += 3;
    if (it === 0) score += 60;
    else if (it > 0 && /[\s\-_./|:]/.test(title[it - 1] || '')) score += 40;
    else if (it > 0) score += 20;
    if (domain.startsWith(t)) score += 25;
    else if (iu !== -1) score += 8;
  }
  if (!node.url) score += 5; // las carpetas que matchean, un poco arriba
  return score;
}

const OPERATORS = {
  site: 'site', sitio: 'site',
  in: 'path', en: 'path', folder: 'path', carpeta: 'path',
  is: 'kind', es: 'kind',
};
const KINDS = { folder: 'folder', folders: 'folder', carpeta: 'folder', carpetas: 'folder',
  bookmark: 'bookmark', bookmarks: 'bookmark', link: 'bookmark', marcador: 'bookmark', marcadores: 'bookmark' };

// Operadores: site:github.com  in:dev  is:folder  -excluir  "frase exacta"
export function parseQuery(query) {
  const q = { tokens: [], filters: [], kind: null };
  for (const m of String(query).matchAll(/(-)?(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi)) {
    const [, neg, rawOp, quoted, bare] = m;
    const op = rawOp && OPERATORS[rawOp.toLowerCase()];
    const value = normalize(quoted ?? bare ?? '').trim();
    if (rawOp && !op) {
      // No es un operador (p. ej. «http:»): se busca como texto literal.
      const literal = normalize(m[0].replace(/^-/, ''));
      if (neg) q.filters.push({ field: 'text', value: literal, neg: true }); else q.tokens.push(literal);
      continue;
    }
    if (!value) { if (op) q.tokens.push(normalize(rawOp) + ':'); continue; }
    if (op === 'kind') { q.kind = KINDS[value] || 'none'; continue; }
    if (op) { q.filters.push({ field: op, value: op === 'site' ? value.replace(/^www\./, '') : value, neg: !!neg }); continue; }
    if (neg) q.filters.push({ field: 'text', value, neg: true });
    else if (quoted != null) q.tokens.push(value);
    else q.tokens.push(...tokenize(value));
  }
  q.empty = !q.tokens.length && !q.filters.length && !q.kind;
  return q;
}

export function queryScore(node, q, path = '') {
  if (q.empty) return -1;
  if (q.kind === 'none' || (q.kind === 'folder' && node.url) || (q.kind === 'bookmark' && !node.url)) return -1;
  if (q.filters.length) {
    const domain = node.url ? normalize(domainOf(node.url)) : '';
    const folderPath = normalize(path);
    const text = normalize(`${node.title || ''} ${node.url || ''}`);
    for (const f of q.filters) {
      if (f.field === 'site' && !node.url) { if (f.neg) continue; return -1; }
      const hit = f.field === 'site' ? domain.includes(f.value)
        : f.field === 'path' ? folderPath.includes(f.value)
          : text.includes(f.value) || folderPath.includes(f.value);
      if (hit === f.neg) return -1;
    }
  }
  if (!q.tokens.length) return node.url ? 10 : 5;
  return searchScore(node, q.tokens, path);
}

// Resalta ocurrencias de los tokens (devuelve HTML seguro)
export function highlight(text, tokens) {
  const raw = String(text);
  if (!tokens?.length) return escapeHtml(raw);
  const norm = normalize(raw);
  const marks = new Array(raw.length).fill(false);
  for (const t of tokens) {
    let from = 0;
    while (true) {
      const i = norm.indexOf(t, from);
      if (i === -1) break;
      for (let j = i; j < Math.min(i + t.length, raw.length); j++) marks[j] = true;
      from = i + t.length;
    }
  }
  let out = '';
  let open = false;
  for (let i = 0; i < raw.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += escapeHtml(raw[i]);
  }
  if (open) out += '</mark>';
  return out;
}
