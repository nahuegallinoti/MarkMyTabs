import {
  $, el, svg, domainOf, fmtNum, debounce,
  parseQuery, queryScore, highlight, faviconEl, loadPref, savePref,
  bm, openUrl, IS_EXT, lastSaveFolder, rememberSaveFolder, recentFolders, bookmarkUrlKey,
} from '../common/utils.js';
import { folderPicker } from '../common/folder-picker.js';
import { applyI18n, getLang, languageButtonText, languageButtonTitle, setLang, tr } from '../common/i18n.js';

const searchInput = $('#search');
const resultsBox = $('#results');
const currentBox = $('#currentPage');
const bodyBox = $('#body');

let allBookmarks = [];
let nodeById = new Map();
let countsById = new Map();   // marcadores recursivos por carpeta
let rootFolders = [];
let currentTab = null;
let preferredFolder = null;
let popupView = loadPref('mp-popup-view', 'folders');
let noticeTimer;

let expanded = new Set(loadPref('mp-popup-expanded', []));
let expandedLoaded = loadPref('mp-popup-expanded', null) !== null;
let activeId = null;          // fila resaltada para navegación con teclado

function pathLabel(node) {
  const parts = [];
  let p = node.parentId ? nodeById.get(node.parentId) : null;
  while (p && p.parentId) { parts.unshift(p.title || tr('Untitled', 'Sin nombre')); p = nodeById.get(p.parentId); }
  return parts.join(' / ');
}

async function loadData() {
  const [root] = await bm.getTree();
  nodeById = new Map();
  countsById = new Map();
  allBookmarks = [];
  (function walk(n) {
    nodeById.set(n.id, n);
    if (n.url) { allBookmarks.push(n); return 1; }
    let b = 0;
    for (const c of n.children || []) b += walk(c);
    countsById.set(n.id, b);
    return b;
  })(root);
  rootFolders = root.children || [];
  $('#total').textContent = `${fmtNum(allBookmarks.length)} ${allBookmarks.length === 1 ? tr('bookmark', 'marcador') : tr('bookmarks', 'marcadores')}`;
}

// ---------- árbol de carpetas ----------
function folderBlock(folder) {
  const open = expanded.has(folder.id);
  const cnt = countsById.get(folder.id) || 0;
  const row = el('button', {
    class: 'row tree', dataset: { id: folder.id, folder: '1' },
    'aria-expanded': String(open),
    title: folder.title || tr('Untitled', 'Sin nombre'),
  },
    el('span', { class: `twist${open ? ' open' : ''}`, html: svg('chevron', 12) }),
    el('span', { class: 'icn folder-icn', html: svg(open ? 'folderOpen' : 'folder', 15) }),
    el('span', { class: 'tlabel', text: folder.title || tr('Untitled', 'Sin nombre') }),
    el('span', { class: 'count', text: cnt ? fmtNum(cnt) : '' }));
  row.addEventListener('click', () => toggleFolder(folder.id));
  const wrap = el('div', { class: 'node' }, row);
  if (open) {
    const kids = el('div', { class: 'kids' });
    const children = folder.children || [];
    if (!children.length) {
      kids.append(el('div', { class: 'empty-row', text: tr('Empty folder', 'Carpeta vacía') }));
    }
    for (const c of children) kids.append(c.url ? bookmarkRow(c) : folderBlock(c));
    wrap.append(kids);
  }
  return wrap;
}

function bookmarkRow(n) {
  const row = el('button', {
    class: 'row tree bm', dataset: { id: n.id },
    title: `${n.title || ''}\n${n.url}`,
  },
    faviconEl(n.url, 16),
    el('span', { class: 'tlabel', text: n.title || domainOf(n.url) }),
    el('span', { class: 'icn go', html: svg('arrowUpRight', 13) }));
  row.addEventListener('click', () => { openUrl(n.url); window.close(); });
  return row;
}

function toggleFolder(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  savePref('mp-popup-expanded', [...expanded]);
  activeId = id;
  renderKeepingScroll();
}

function renderKeepingScroll() {
  const st = bodyBox.scrollTop;
  render();
  bodyBox.scrollTop = st;
}

// ---------- render ----------
function render() {
  const q = searchInput.value.trim();
  resultsBox.innerHTML = '';

  if (!q) {
    currentBox.hidden = !currentTab;
    if (!expandedLoaded) { for (const r of rootFolders) expanded.add(r.id); expandedLoaded = true; }
    if (popupView === 'recent') {
      resultsBox.append(el('div', { class: 'group-label', text: tr('Recently saved', 'Guardados recientemente') }));
      for (const n of allBookmarks.slice().sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0)).slice(0, 30)) resultsBox.append(resultRow(n, []));
      if (!allBookmarks.length) resultsBox.append(el('div', { class: 'empty-msg', text: tr('Save a page to start your collection.', 'Guarda una página para empezar tu colección.') }));
      applyActive(); return;
    }
    const hasAnything = allBookmarks.length || rootFolders.some((f) => f.children?.length);
    if (!hasAnything) {
      resultsBox.append(el('div', { class: 'empty-msg', text: tr('You do not have any saved bookmarks yet.', 'Todavía no tienes marcadores guardados.') }));
    } else {
      for (const r of rootFolders) resultsBox.append(folderBlock(r));
    }
    applyActive();
    return;
  }

  currentBox.hidden = true;
  const parsed = parseQuery(q);
  const tokens = parsed.tokens;
  const scored = [];
  for (const n of nodeById.values()) {
    if (!n.parentId) continue;
    const s = queryScore(n, parsed, pathLabel(n));
    if (s >= 0) scored.push([s, n]);
  }
  scored.sort((a, b) => b[0] - a[0] || (b[1].dateAdded || 0) - (a[1].dateAdded || 0));
  const top = scored.slice(0, 12).map((r) => r[1]);
  if (!top.length) {
    resultsBox.append(el('div', { class: 'empty-msg', text: tr(`No results for “${q}”`, `Sin resultados para “${q}”`) }));
    applyActive();
    return;
  }
  for (const n of top) resultsBox.append(resultRow(n, tokens));
  if (scored.length > top.length) {
    const more = el('button', { class: 'row', dataset: { id: '__more' } },
      el('span', { class: 'icn folder-icn', html: svg('search', 15) }),
      el('span', { class: 'meta' }, el('span', { class: 'title', text: tr(`View all ${fmtNum(scored.length)} results`, `Ver los ${fmtNum(scored.length)} resultados`) })),
      el('span', { class: 'icn go', html: svg('arrowUpRight', 14) }));
    more.addEventListener('click', () => openManager(`?q=${encodeURIComponent(q)}`));
    resultsBox.append(more);
  }
  applyActive();
}

function resultRow(node, tokens) {
  const isFolder = !node.url;
  const row = el('button', { class: 'row', dataset: { id: node.id } },
    isFolder ? el('span', { class: 'icn folder-icn', html: svg('folder', 16) }) : faviconEl(node.url, 18),
    el('span', { class: 'meta' },
      el('span', { class: 'title', html: highlight(node.title || (isFolder ? tr('Untitled', 'Sin nombre') : domainOf(node.url)), tokens) }),
      el('span', { class: 'sub', text: isFolder ? pathLabel(node) || tr('Folder', 'Carpeta') : (pathLabel(node) ? `${pathLabel(node)} · ` : '') + domainOf(node.url) })),
    el('span', { class: 'icn go', html: svg(isFolder ? 'chevron' : 'arrowUpRight', 14) }));
  row.addEventListener('click', () => openNode(node));
  return row;
}

function openNode(node) {
  if (node.url) {
    openUrl(node.url);
    window.close();
  } else {
    openManager(`?folder=${encodeURIComponent(node.id)}`);
  }
}

function openManager(params = '') {
  if (IS_EXT) {
    chrome.runtime.sendMessage({ type: 'open-manager', params }).catch(() => {});
    window.close();
  } else {
    window.open(`../manager/manager.html${params}`, '_blank');
  }
}

// ---------- navegación con teclado ----------
const navRows = () => [...resultsBox.querySelectorAll('button.row')];

function applyActive() {
  for (const r of navRows()) {
    r.classList.toggle('active', r.dataset.id === activeId);
    r.id = 'popup-row-' + r.dataset.id;
  }
  if (activeId) searchInput.setAttribute('aria-activedescendant', 'popup-row-' + activeId);
  else searchInput.removeAttribute('aria-activedescendant');
}

function activeIndex() {
  return navRows().findIndex((r) => r.dataset.id === activeId);
}

function setActiveByIndex(i) {
  const rows = navRows();
  if (!rows.length) return;
  if (i < 0) {
    activeId = null;
    applyActive();
    return;
  }
  const idx = Math.min(rows.length - 1, i);
  activeId = rows[idx].dataset.id ?? null;
  applyActive();
  rows[idx].scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('keydown', (e) => {
  const rows = navRows();
  if (e.key === 'ArrowDown') { e.preventDefault(); setActiveByIndex(activeIndex() + 1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); setActiveByIndex(activeIndex() - 1); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const row = rows[activeIndex() >= 0 ? activeIndex() : 0];
    row?.click();
    return;
  }
  if (e.key === 'Escape' && searchInput.value) {
    searchInput.value = '';
    $('#btnClear').hidden = true;
    activeId = null;
    render();
    return;
  }
  // expandir/contraer carpetas con ← → (solo cuando no se está escribiendo)
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !searchInput.value) {
    const row = rows[activeIndex()];
    if (!row?.dataset.folder) return;
    e.preventDefault();
    const id = row.dataset.id;
    const isOpen = expanded.has(id);
    if (e.key === 'ArrowRight' && !isOpen) toggleFolder(id);
    if (e.key === 'ArrowLeft' && isOpen) toggleFolder(id);
  }
});

searchInput.addEventListener('input', debounce(() => { activeId = null; $('#btnClear').hidden = !searchInput.value; render(); }, 100));

// ---------- página actual ----------
async function loadCurrentTab() {
  if (!IS_EXT || !chrome.tabs?.query) {
    currentTab = { title: tr('Example page (development mode)', 'Página de ejemplo (modo desarrollo)'), url: 'https://example.dev/article' };
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && /^https?:/.test(tab.url)) currentTab = { title: tab.title || tab.url, url: tab.url };
    } catch { /* sin permiso */ }
  }
  if (!currentTab) return;
  renderCurrent();
}

function findByUrl(url) {
  return allBookmarks.find((b) => bookmarkUrlKey(b.url) === bookmarkUrlKey(url));
}

function notice(message, undo) {
  clearTimeout(noticeTimer);
  const box = $('#notice');
  box.hidden = false;
  box.replaceChildren(el('span', { text: message }));
  if (undo) box.append(el('button', { text: tr('Undo', 'Deshacer'), onClick: async () => {
    box.hidden = true;
    try { await undo(); await loadData(); renderCurrent(); renderKeepingScroll(); }
    catch (err) { notice(err.message || tr('Could not undo', 'No se pudo deshacer')); }
  } }));
  noticeTimer = setTimeout(() => { box.hidden = true; }, undo ? 10000 : 5000);
}

function renderCurrent() {
  currentBox.innerHTML = '';
  currentBox.hidden = !!searchInput.value.trim();
  const existing = findByUrl(currentTab.url);
  const star = el('button', {
    class: `star${existing ? ' saved' : ''}`,
    title: existing ? tr('Remove from bookmarks', 'Quitar de marcadores') : tr('Save this page', 'Guardar esta página'),
    'aria-pressed': String(!!existing),
  });
  star.innerHTML = existing
    ? `<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>`
    : svg('bookmark', 19);
  star.addEventListener('click', async () => {
    if (star.disabled) return;
    star.disabled = true;
    const cur = findByUrl(currentTab.url);
    try {
      if (cur) {
        await bm.remove(cur.id);
        notice(tr('Bookmark removed', 'Marcador eliminado'), () => bm.create({ parentId: cur.parentId, index: cur.index, title: cur.title, url: cur.url }));
      } else {
        const created = await bm.create({ parentId: nodeById.has(preferredFolder) ? preferredFolder : rootFolders[0]?.id, title: currentTab.title, url: currentTab.url });
        notice(tr('Page saved', 'Página guardada'), () => bm.remove(created.id));
      }
      await loadData();
      renderCurrent();
      renderKeepingScroll();
    } catch (err) { notice(err.message || tr('Could not save. Try again.', 'No se pudo guardar. Reintenta.')); }
    finally { star.disabled = false; }
  });
  const summary = el('div', { class: 'current-summary' },
    faviconEl(currentTab.url, 20),
    el('span', { class: 'meta' },
      el('span', { class: 'title', text: currentTab.title }),
      el('span', { class: 'sub', text: existing ? pathLabel(existing) : tr('Current page · Not saved', 'Página actual · Sin guardar') })),
    star,
  );
  const edit = el('button', { class: 'edit-current', text: existing ? tr('Edit name & folder', 'Editar nombre y carpeta') : tr('Choose folder & save', 'Elegir carpeta y guardar') });
  edit.addEventListener('click', async () => {
    edit.hidden = true;
    const name = el('input', { type: 'text', class: 'name-input', value: existing?.title || currentTab.title, 'aria-label': tr('Bookmark name', 'Nombre del marcador') });
    const folder = folderPicker({
      roots: rootFolders, recent: await recentFolders(),
      value: existing?.parentId || (nodeById.has(preferredFolder) ? preferredFolder : rootFolders[0]?.id),
      onActivate: () => form.requestSubmit(),
    });
    const submit = el('button', { class: 'save-current', type: 'submit', text: tr('Save', 'Guardar') });
    const cancel = el('button', { type: 'button', text: tr('Cancel', 'Cancelar'), onClick: () => renderCurrent() });
    const form = el('form', { class: 'current-editor' }, name, folder.el, el('div', { class: 'editor-actions' }, cancel, submit));
    form.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.stopPropagation(); form.requestSubmit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderCurrent(); }
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const title = name.value.trim() || domainOf(currentTab.url);
        if (!folder.value) throw new Error(tr('Choose a folder.', 'Elige una carpeta.'));
        if (existing) {
          await bm.update(existing.id, { title });
          if (folder.value !== existing.parentId) await bm.move(existing.id, { parentId: folder.value });
        } else await bm.create({ parentId: folder.value, title, url: currentTab.url });
        preferredFolder = folder.value;
        await rememberSaveFolder(preferredFolder);
        await loadData(); renderCurrent(); renderKeepingScroll();
        notice(tr('Bookmark saved', 'Marcador guardado'));
      } catch (err) { notice(err.message || tr('Could not save. Try again.', 'No se pudo guardar. Reintenta.')); }
      finally { submit.disabled = false; }
    });
    currentBox.append(form); name.focus(); name.select();
  });
  currentBox.append(summary, edit);
}

function renderPopupViews() {
  const views = $('#popupViews');
  views.replaceChildren();
  for (const [id, label, icon] of [['folders', tr('Folders', 'Carpetas'), 'folder'], ['recent', tr('Recent', 'Recientes'), 'clock']]) {
    views.append(el('button', { 'aria-pressed': String(popupView === id), onClick: () => {
      popupView = id; savePref('mp-popup-view', id); activeId = null; renderPopupViews(); render();
    } }, el('span', { class: 'icn', html: svg(icon, 14) }), label));
  }
}

// ---------- init ----------
async function init() {
  applyI18n();
  searchInput.setAttribute('aria-label', tr('Search your bookmarks', 'Buscar en tus marcadores'));
  $('#btnClear').innerHTML = svg('x', 14);
  $('#btnClear').title = tr('Clear search', 'Limpiar búsqueda');
  $('#btnClear').addEventListener('click', () => { searchInput.value = ''; $('#btnClear').hidden = true; activeId = null; render(); searchInput.focus(); });
  const theme = $('#btnTheme');
  const applyTheme = () => { const dark = document.documentElement.dataset.theme === 'dark'; theme.innerHTML = svg(dark ? 'sun' : 'moon', 16); theme.title = dark ? tr('Light theme', 'Tema claro') : tr('Dark theme', 'Tema oscuro'); };
  theme.addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('mp-theme', next); document.documentElement.dataset.theme = next; applyTheme(); });
  applyTheme(); renderPopupViews();
  $('#searchBar .search-icn').innerHTML = svg('search', 16);
  const mb = $('#btnManager');
  mb.innerHTML = `${svg('grid', 14)}<span>${tr('Manager', 'Administrador')}</span>`;
  mb.addEventListener('click', () => openManager());
  const lb = $('#btnLang');
  lb.textContent = languageButtonText();
  lb.title = languageButtonTitle();
  lb.addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'es' : 'en');
    location.reload();
  });
  const tb = $('#btnSaveTabs');
  tb.innerHTML = svg('layers', 15);
  tb.title = tr('Save all tabs in this window to a folder', 'Guardar todas las pestañas de esta ventana en una carpeta');
  tb.addEventListener('click', async () => {
    let windowId = '';
    try { if (IS_EXT) windowId = String((await chrome.windows.getCurrent()).id); } catch { /* */ }
    openManager(`?saveTabs=${encodeURIComponent(windowId || 'current')}`);
  });
  const cb = $('#btnCollapse');
  cb.innerHTML = svg('collapse', 15);
  cb.addEventListener('click', () => {
    expanded = new Set();
    savePref('mp-popup-expanded', [...expanded]);
    activeId = null;
    render();
    bodyBox.scrollTop = 0;
  });

  bodyBox.addEventListener('scroll', debounce(() => savePref('mp-popup-scroll', bodyBox.scrollTop), 150), { passive: true });

  preferredFolder = await lastSaveFolder();
  await loadData();
  render();
  await loadCurrentTab();
  bodyBox.scrollTop = loadPref('mp-popup-scroll', 0);
  searchInput.focus();
  bm.onAny(debounce(async () => {
    const editing = currentBox.querySelector('form');
    await loadData();
    if (currentTab && !editing) renderCurrent();
    renderKeepingScroll();
  }, 200));
}

init().catch(err => notice(err.message || tr('Could not load bookmarks', 'No se pudieron cargar los marcadores')));
