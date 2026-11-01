import { escapeHtml, normalizeUrl } from './utils.js';
import { tr } from './i18n.js';

// Portable backups contain data only: never bookmark IDs or executable markup.
export function portableNodes(nodes) {
  return nodes.map(n => ({ title: n.title || '', ...(n.url
    ? { url: n.url } : { children: portableNodes(n.children || []) }) }));
}

export function exportJson(nodes) {
  return JSON.stringify({ format: 'mark-my-tabs', version: 1, exportedAt: new Date().toISOString(), children: portableNodes(nodes) }, null, 2);
}

export function exportHtml(nodes) {
  const render = list => list.map(n => n.url
    ? `<DT><A HREF="${escapeHtml(n.url)}">${escapeHtml(n.title || n.url)}</A>`
    : `<DT><H3>${escapeHtml(n.title || '')}</H3>\n<DL><p>\n${render(n.children || [])}\n</DL><p>`).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Mark My Tabs</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${render(nodes)}\n</DL><p>`;
}

export function parseBackup(text, html = false) {
  let raw;
  if (html) {
    // DOMParser is inert: imported markup is never inserted in the live page.
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const list = doc.querySelector('dl');
    if (!list) throw new Error(tr('No bookmark list found in this HTML file.', 'El archivo HTML no contiene una lista de marcadores.'));
    const read = (dl, depth = 0) => {
      if (depth > 32) throw new Error(tr('Too many nested folders.', 'Hay demasiados niveles de carpetas.'));
      const result = [];
      // Browsers repair Netscape's optional closing tags in different ways.
      for (const dt of dl.querySelectorAll('dt')) {
        if (dt.closest('dl') !== dl) continue;
        const a = dt.querySelector(':scope > a');
        const h = dt.querySelector(':scope > h3');
        if (a) result.push({ title: a.textContent, url: a.getAttribute('href') });
        else if (h) {
          const child = dt.querySelector(':scope > dl') || (dt.nextElementSibling?.tagName === 'DL' ? dt.nextElementSibling : null);
          result.push({ title: h.textContent, children: child ? read(child, depth + 1) : [] });
        }
      }
      return result;
    };
    raw = read(list);
  } else {
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error(tr('This file is not valid JSON.', 'El archivo no contiene JSON válido.')); }
    if (value?.format === 'mark-my-tabs' && value.version !== 1) throw new Error(tr('Unsupported backup version.', 'Versión de respaldo no compatible.'));
    raw = Array.isArray(value) ? value : value?.children;
    // Accept chrome.bookmarks.getTree() as well as our own format.
    if (Array.isArray(raw) && raw.length === 1 && raw[0]?.id === '0') raw = raw[0].children;
  }
  let bookmarks = 0, folders = 0, count = 0;
  const validate = (nodes, depth = 0) => {
    if (!Array.isArray(nodes) || depth > 32) throw new Error(tr('Invalid folder structure.', 'La estructura de carpetas no es válida.'));
    return nodes.map(n => {
      if (++count > 20000) throw new Error(tr('Import up to 20,000 items at a time.', 'Importa hasta 20.000 elementos a la vez.'));
      if (!n || typeof n !== 'object' || typeof n.title !== 'string') throw new Error(tr('Invalid bookmark data.', 'Los datos del marcador no son válidos.'));
      if ('url' in n) {
        if (typeof n.url !== 'string') throw new Error(tr('Invalid bookmark URL.', 'La URL del marcador no es válida.'));
        const url = normalizeUrl(n.url, { addScheme: false });
        if (!url) throw new Error(tr('The file contains an unsupported or unsafe URL.', 'El archivo contiene una URL no compatible o insegura.'));
        bookmarks++;
        return { title: n.title.slice(0, 10000), url };
      }
      folders++;
      return { title: n.title.slice(0, 10000), children: validate(n.children, depth + 1) };
    });
  };
  const children = validate(raw);
  if (!children.length) throw new Error(tr('This backup is empty.', 'El respaldo está vacío.'));
  return { children, bookmarks, folders };
}

export function downloadFile(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
