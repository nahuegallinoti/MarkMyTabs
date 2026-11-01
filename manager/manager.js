import {
  $, $$, el, svg, domainOf, fmtNum, timeAgo, fullDate, debounce,
  parseQuery, queryScore, highlight, faviconEl, loadPref, savePref,
  bm, openUrl, openInWindow, openUrls, IS_EXT, normalizeUrl, bookmarkUrlKey,
  recentFolders, rememberFolder,
} from '../common/utils.js';
import { exportJson, exportHtml, parseBackup, downloadFile } from '../common/backup.js';
import { folderPicker } from '../common/folder-picker.js';
import { checkLinks, loadLinkReport, saveLinkReport } from './links.js';
import {
  applyI18n, getLang, getLocale, languageButtonText, languageButtonTitle, setLang, tr,
} from '../common/i18n.js';

// ============ Estado ============
const state = {
  view: loadPref('mp-view', { type: 'folder', folderId: null }),
  query: '',
  sort: loadPref('mp-sort', 'manual'),
  layout: loadPref('mp-layout', 'grid'),
  expanded: new Set(loadPref('mp-expanded', [])),
  selection: new Set(),
  anchorIndex: null,
  items: [],          // nodos renderizados, en orden visual
  limit: 400,
  tipDismissed: loadPref('mp-tip-dismissed', false),
  searchKind: 'all',
  searchScope: 'all',
  pinned: new Set(loadPref('mp-pinned-folders', [])),
  cleanupTab: loadPref('mp-cleanup-tab', 'dupes'),
};
if (state.view.type === 'dupes') state.view = { type: 'cleanup' };

let recentCache = [];
let linkReport = null;   // último informe de enlaces: { checkedAt, total, problems }
let linkRun = null;      // revisión en curso: { done, total, problems, cancelled }
let lastUndo = null;     // { run, dismiss } del último aviso con «Deshacer» (Ctrl+Z)

let tree = null;
let nodeById = new Map();
let countsById = new Map();   // { b: marcadores recursivos, f: carpetas recursivas }
let allBookmarks = [];
let rootFolders = [];

const content = $('#content');
const searchInput = $('#search');

const sorts = () => [
  { id: 'manual', label: tr('Custom', 'Personalizado') },
  { id: 'title-asc', label: tr('Name (A → Z)', 'Nombre (A → Z)') },
  { id: 'title-desc', label: tr('Name (Z → A)', 'Nombre (Z → A)') },
  { id: 'date-new', label: tr('Newest first', 'Más recientes primero') },
  { id: 'date-old', label: tr('Oldest first', 'Más antiguos primero') },
  { id: 'domain', label: tr('Site (A → Z)', 'Sitio (A → Z)') },
];

// ============ Datos ============
async function refresh() {
  const [root] = await bm.getTree();
  tree = root;
  nodeById = new Map();
  countsById = new Map();
  allBookmarks = [];
  walk(root);
  rootFolders = root.children || [];
  for (const id of [...state.selection]) if (!nodeById.has(id)) state.selection.delete(id);
  if (state.view.type === 'folder' && (!state.view.folderId || !nodeById.get(state.view.folderId) || nodeById.get(state.view.folderId).url)) {
    state.view = { type: 'folder', folderId: rootFolders[0]?.id };
  }
  renderSidebar();
  renderContent();
}

function walk(node) {
  nodeById.set(node.id, node);
  if (node.url) { allBookmarks.push(node); return { b: 1, f: 0 }; }
  let b = 0, f = 0;
  for (const c of node.children || []) {
    const r = walk(c);
    b += r.b;
    f += r.f + (c.url ? 0 : 1);
  }
  countsById.set(node.id, { b, f });
  return { b, f };
}

const searching = () => state.query.trim().length > 0;
const isRootFolder = (n) => n && n.parentId === tree.id;

function pathOf(node) {
  const out = [];
  let p = node?.parentId ? nodeById.get(node.parentId) : null;
  while (p && p.id !== tree.id) { out.unshift(p); p = p.parentId ? nodeById.get(p.parentId) : null; }
  return out;
}

function isDescendant(id, ancestorId) {
  let p = nodeById.get(id)?.parentId;
  while (p) { if (p === ancestorId) return true; p = nodeById.get(p)?.parentId; }
  return false;
}

// filtra ids cuyo ancestro también está en la lista
function topLevelOnly(ids) {
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = nodeById.get(id)?.parentId;
    while (p) { if (set.has(p)) return false; p = nodeById.get(p)?.parentId; }
    return true;
  });
}

function collectUrls(folder) {
  const out = [];
  (function w(n) { for (const c of n.children || []) { if (c.url) out.push(c.url); else w(c); } })(folder);
  return out;
}

function urlKey(url) {
  return bookmarkUrlKey(url);
}

function dupeGroups() {
  const map = new Map();
  for (const n of allBookmarks) {
    const k = urlKey(n.url);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(n);
  }
  return [...map.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

// Carpetas sin ningún marcador adentro (solo la más alta de cada rama vacía)
function emptyFolders() {
  const out = [];
  (function w(n) {
    for (const c of n.children || []) {
      if (c.url) continue;
      if (!isRootFolder(c) && !(countsById.get(c.id)?.b)) out.push(c);
      else w(c);
    }
  })(tree);
  return out;
}

function noteFolder(id) {
  if (!id) return;
  recentCache = [id, ...recentCache.filter(x => x !== id)].slice(0, 8);
  rememberFolder(id);
}

function cmpTitle(a, b) {
  return (a.title || '').localeCompare(b.title || '', getLocale(), { sensitivity: 'base' });
}

function sortArr(arr, { fallbackDate = false } = {}) {
  switch (state.sort) {
    case 'title-asc': arr.sort(cmpTitle); break;
    case 'title-desc': arr.sort((a, b) => cmpTitle(b, a)); break;
    case 'date-new': arr.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0)); break;
    case 'date-old': arr.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0)); break;
    case 'domain': arr.sort((a, b) => domainOf(a.url || '').localeCompare(domainOf(b.url || ''), getLocale()) || cmpTitle(a, b)); break;
    default: if (fallbackDate) arr.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
  }
  return arr;
}

const errMsg = (err) => tr('Could not complete the action: ', 'No se pudo completar: ') + (err?.message || tr('unknown error', 'error desconocido'));

// ============ Navegación ============
function setView(v) {
  state.view = v;
  state.limit = 400;
  clearSelection({ silent: true });
  if (searching()) { state.query = ''; searchInput.value = ''; $('#btnClearSearch').hidden = true; }
  if (v.type === 'folder' && v.folderId) {
    for (const a of pathOf(nodeById.get(v.folderId))) state.expanded.add(a.id);
    savePref('mp-expanded', [...state.expanded]);
  }
  savePref('mp-view', { type: v.type, folderId: v.folderId ?? null });
  closeSidebarMobile();
  renderSidebar();
  renderContent();
  content.scrollTop = 0;
}

function setQuery(q, { fromInput = false } = {}) {
  state.query = q;
  if (!fromInput) searchInput.value = q;
  $('#btnClearSearch').hidden = !q;
  state.limit = 400;
  clearSelection({ silent: true });
  renderSidebar();
  renderContent();
}

function openItem(node) {
  if (node.url) openUrl(node.url);
  else setView({ type: 'folder', folderId: node.id });
}

// ============ Sidebar ============
function renderSidebar() {
  renderViews();
  renderTree();
  const t = countsById.get(tree.id) || { b: 0, f: 0 };
  $('#stats').textContent = `${fmtNum(t.b)} ${tr('bookmarks', 'marcadores')} · ${fmtNum(Math.max(0, t.f - rootFolders.length))} ${tr('folders', 'carpetas')}`;
}

function renderViews() {
  const wrap = $('#views');
  wrap.innerHTML = '';
  const total = countsById.get(tree.id) || { b: 0 };
  const extras = dupeGroups().reduce((n, g) => n + g.length - 1, 0);
  const defs = [
    { id: 'all', label: tr('All bookmarks', 'Todos los marcadores'), icon: 'bookmark', count: fmtNum(total.b) },
    { id: 'recent', label: tr('Recent', 'Recientes'), icon: 'clock' },
    { id: 'cleanup', label: tr('Cleanup', 'Limpieza'), icon: 'sparkles', badge: extras || null },
  ];
  for (const d of defs) {
    const active = !searching() && state.view.type === d.id;
    const b = el('button', { class: `side-item${active ? ' active' : ''}` },
      el('span', { class: 'icn', html: svg(d.icon, 17) }),
      el('span', { class: 'label', text: d.label }),
      d.badge ? el('span', { class: 'badge', text: String(d.badge) })
        : (d.count != null ? el('span', { class: 'count', text: d.count }) : null));
    b.addEventListener('click', () => setView({ type: d.id }));
    wrap.append(b);
  }
  const pinned = [...state.pinned].map(id => nodeById.get(id)).filter(n => n && !n.url);
  if (pinned.length) wrap.append(el('div', { class: 'tree-head', text: tr('Pinned folders', 'Carpetas fijadas') }));
  for (const folder of pinned) {
    wrap.append(el('button', {
      class: `side-item${state.view.folderId === folder.id && !searching() ? ' active' : ''}`,
      title: folder.title,
      onClick: () => setView({ type: 'folder', folderId: folder.id }),
    }, el('span', { class: 'icn', html: svg('pin', 16) }), el('span', { class: 'label', text: folder.title || tr('Untitled', 'Sin nombre') })));
  }
}

function renderTree() {
  const wrap = $('#tree');
  wrap.innerHTML = '';
  const build = (folder, depth) => {
    const subs = (folder.children || []).filter((c) => !c.url);
    const isOpen = state.expanded.has(folder.id);
    const active = !searching() && state.view.type === 'folder' && state.view.folderId === folder.id;
    const row = el('div', {
      class: `tree-row${active ? ' active' : ''}`,
      role: 'treeitem', 'aria-expanded': subs.length ? String(isOpen) : null,
      tabindex: '0', 'aria-selected': String(active), 'aria-level': depth + 1,
      dataset: { id: folder.id },
      style: `padding-left:${6 + depth * 14}px`,
    });
    const twist = el('button', {
      class: `twist${isOpen ? ' open' : ''}${subs.length ? '' : ' leaf'}`,
      html: svg('chevron', 13), tabindex: '-1',
      title: isOpen ? tr('Collapse', 'Contraer') : tr('Expand', 'Expandir'),
    });
    twist.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(folder.id); });
    const cnt = countsById.get(folder.id)?.b || 0;
    const menuBtn = el('button', { class: 'icon-btn sm row-menu', html: svg('more', 14), title: tr('Options', 'Opciones'), tabindex: '-1' });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, folderMenuItems(folder));
    });
    row.append(
      twist,
      el('span', { class: 'icn', html: svg(active ? 'folderOpen' : 'folder', 16) }),
      el('span', { class: 'label', text: folder.title || tr('Untitled', 'Sin nombre') }),
      el('span', { class: 'count', text: cnt ? fmtNum(cnt) : '' }),
      menuBtn,
    );
    row.addEventListener('click', () => setView({ type: 'folder', folderId: folder.id }));
    row.addEventListener('keydown', e => {
      if (e.target !== row) return;
      const rows = $$('.tree-row', wrap);
      const index = rows.indexOf(row);
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const focusFolder = id => $('#tree [data-id="' + CSS.escape(id) + '"]')?.focus();
      if (e.key === 'Enter' || e.key === ' ') { setView({ type: 'folder', folderId: folder.id }); focusFolder(folder.id); }
      else if (e.key === 'ArrowDown') rows[Math.min(rows.length - 1, index + 1)]?.focus();
      else if (e.key === 'ArrowUp') rows[Math.max(0, index - 1)]?.focus();
      else if (e.key === 'Home') rows[0]?.focus();
      else if (e.key === 'End') rows.at(-1)?.focus();
      else if ((e.key === 'ArrowRight' && subs.length && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) {
        toggleExpand(folder.id); focusFolder(folder.id);
      } else if (e.key === 'ArrowLeft') focusFolder(folder.parentId);
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, folderMenuItems(folder)); });
    bindTreeDrop(row, folder);
    wrap.append(row);
    if (isOpen) for (const s of subs) build(s, depth + 1);
  };
  for (const r of rootFolders) build(r, 0);
}

function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  savePref('mp-expanded', [...state.expanded]);
  renderTree();
}

function bindTreeDrop(row, folder) {
  let expandTimer = null;
  row.addEventListener('dragover', (e) => {
    if (isLinkDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      clearDropMarkers();
      row.classList.add('drop-into');
      return;
    }
    if (!draggingIds) return;
    if (draggingIds.includes(folder.id)) return;
    if (draggingIds.some((id) => isDescendant(folder.id, id))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarkers();
    row.classList.add('drop-into');
    if (!expandTimer && !state.expanded.has(folder.id) && (folder.children || []).some((c) => !c.url)) {
      expandTimer = setTimeout(() => toggleExpand(folder.id), 650);
    }
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-into');
    clearTimeout(expandTimer); expandTimer = null;
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(expandTimer);
    if (isLinkDrag(e)) {
      clearDropMarkers();
      const links = linksFromDrop(e.dataTransfer);
      if (links.length) addUrls(links, folder.id);
      return;
    }
    const ids = draggingIds;
    draggingIds = null;
    clearDropMarkers();
    if (ids?.length) moveNodesTo(ids, folder.id, null);
  });
}

// ============ Encabezado ============
function setHead({ crumbs = [], title = '', countText = '', actions = [] }) {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  crumbs.forEach((f, i) => {
    const last = i === crumbs.length - 1;
    if (i > 0) bc.append(el('span', { class: 'sep', html: svg('chevron', 11) }));
    const c = el(last ? 'span' : 'button', { class: `crumb${last ? ' current' : ''}`, text: f.title || tr('Untitled', 'Sin nombre') });
    if (!last) c.addEventListener('click', () => setView({ type: 'folder', folderId: f.id }));
    bc.append(c);
  });
  $('#viewTitle').textContent = title;
  $('#viewCount').textContent = countText;
  const act = $('#headActions');
  act.innerHTML = '';
  for (const a of actions) act.append(a);
}

// ============ Contenido ============
function togglePinned(id) {
  if (state.pinned.has(id)) state.pinned.delete(id); else state.pinned.add(id);
  savePref('mp-pinned-folders', [...state.pinned]);
  renderSidebar(); renderContent();
}

function renderSearchFilters() {
  const bar = $('#searchFilters');
  bar.hidden = !searching();
  bar.replaceChildren();
  if (!searching()) return;
  for (const [id, label] of [['all', tr('Everything', 'Todo')], ['bookmarks', tr('Bookmarks', 'Marcadores')], ['folders', tr('Folders', 'Carpetas')]]) {
    bar.append(el('button', { class: 'filter-chip', 'aria-pressed': String(state.searchKind === id), text: label,
      onClick: () => { state.searchKind = id; state.limit = 400; clearSelection({ silent: true }); renderContent(); } }));
  }
  if (state.view.type === 'folder') {
    bar.append(el('button', { class: 'filter-chip scope-chip', 'aria-pressed': String(state.searchScope === 'folder'),
      text: tr('In this folder', 'En esta carpeta'),
      onClick: () => { state.searchScope = state.searchScope === 'folder' ? 'all' : 'folder'; clearSelection({ silent: true }); renderContent(); } }));
  }
}

function renderContent() {
  hideMenu();
  renderSearchFilters();
  content.innerHTML = '';
  state.items = [];
  state.anchorIndex = null;
  if (searching()) renderSearch();
  else if (state.view.type === 'all') renderAllView();
  else if (state.view.type === 'recent') renderRecentView();
  else if (state.view.type === 'cleanup') renderCleanupView();
  else renderFolderView();
  syncSelectionUI();
}

function renderFolderView() {
  const folder = nodeById.get(state.view.folderId);
  if (!folder) return;
  const c = countsById.get(folder.id) || { b: 0, f: 0 };
  const actions = [];
  actions.push(btnGhost('pin', state.pinned.has(folder.id) ? tr('Unpin', 'Desfijar') : tr('Pin folder', 'Fijar carpeta'), () => togglePinned(folder.id)));
  if (c.b > 0) {
    actions.push(btnGhost('external', tr('Open all', 'Abrir todos'), () => openAll(collectUrls(folder))));
  }
  actions.push(btnGhost('folderPlus', tr('New folder', 'Nueva carpeta'), () => modalFolder(null, { parentId: folder.id })));
  setHead({
    crumbs: [...pathOf(folder), folder],
    title: folder.title || tr('Untitled', 'Sin nombre'),
    countText: `${fmtNum(c.b)} ${c.b === 1 ? tr('bookmark', 'marcador') : tr('bookmarks', 'marcadores')}${c.f ? ` · ${fmtNum(c.f)} ${c.f === 1 ? tr('folder', 'carpeta') : tr('folders', 'carpetas')}` : ''}`,
    actions,
  });
  const children = (folder.children || []).slice();
  let nodes;
  if (state.sort === 'manual') {
    nodes = children;
  } else {
    const folders = sortArr(children.filter((x) => !x.url));
    const books = sortArr(children.filter((x) => x.url));
    nodes = [...folders, ...books];
  }
  if (!nodes.length) {
    emptyState({
      icon: 'bookmark', title: tr('This folder is empty', 'Esta carpeta está vacía'),
      msg: tr('Add your first bookmark or drag items here.', 'Agrega tu primer marcador o arrastra elementos hasta aquí.'),
      action: { label: tr('New bookmark', 'Nuevo marcador'), onClick: () => modalBookmark(null, { parentId: folder.id }) },
    });
    return;
  }
  renderItems(content, nodes, {});
}

function renderAllView() {
  setHead({
    title: tr('All bookmarks', 'Todos los marcadores'),
    countText: `${fmtNum(allBookmarks.length)} ${allBookmarks.length === 1 ? tr('bookmark', 'marcador') : tr('bookmarks', 'marcadores')}`,
  });
  if (!allBookmarks.length) {
    emptyState({
      icon: 'bookmark', title: tr('No bookmarks yet', 'Todavía no hay marcadores'),
      msg: tr('Save your first page and it will appear here.', 'Guarda tu primera página y va a aparecer acá.'),
      action: { label: tr('New bookmark', 'Nuevo marcador'), onClick: () => modalBookmark(null, {}) },
    });
    return;
  }
  renderLimited(sortArr(allBookmarks.slice(), { fallbackDate: true }), { showPath: true });
}

function renderRecentView() {
  const sorted = allBookmarks.slice().sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0)).slice(0, 150);
  setHead({
    title: tr('Recent', 'Recientes'),
    countText: sorted.length ? tr(`${fmtNum(sorted.length)} recently saved bookmarks`, `Últimos ${fmtNum(sorted.length)} marcadores guardados`) : '',
  });
  if (!sorted.length) {
    emptyState({
      icon: 'clock',
      title: tr('Nothing here yet', 'Nada por aquí todavía'),
      msg: tr('Bookmarks you save will appear here, newest first.', 'Los marcadores que guardes van a aparecer acá, del más nuevo al más viejo.'),
    });
    return;
  }
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = [
    { label: tr('Today', 'Hoy'), test: (t) => t >= startToday },
    { label: tr('Yesterday', 'Ayer'), test: (t) => t >= startToday - 86400000 },
    { label: tr('Last 7 days', 'Últimos 7 días'), test: (t) => t >= startToday - 7 * 86400000 },
    { label: tr('Last 30 days', 'Últimos 30 días'), test: (t) => t >= startToday - 30 * 86400000 },
    { label: tr('Earlier', 'Anteriores'), test: () => true },
  ];
  const grouped = buckets.map((b) => ({ ...b, items: [] }));
  for (const n of sorted) {
    grouped.find((g) => g.test(n.dateAdded || 0)).items.push(n);
  }
  for (const g of grouped) {
    if (!g.items.length) continue;
    content.append(el('div', { class: 'section-label', text: g.label }));
    renderItems(content, g.items, { showPath: true });
  }
}

function renderSearch() {
  const parsed = parseQuery(state.query);
  const tokens = parsed.tokens;
  const results = [];
  for (const n of nodeById.values()) {
    if (n.id === tree.id) continue;
    if (state.searchKind === 'bookmarks' && !n.url || state.searchKind === 'folders' && n.url) continue;
    if (state.searchScope === 'folder' && state.view.type === 'folder' && !isDescendant(n.id, state.view.folderId)) continue;
    const s = queryScore(n, parsed, pathOf(n).map(p => p.title).join(' / '));
    if (s >= 0) results.push([s, n]);
  }
  results.sort((a, b) => b[0] - a[0] || (b[1].dateAdded || 0) - (a[1].dateAdded || 0));
  const nodes = results.map((r) => r[1]);
  setHead({
    title: tr('Results', 'Resultados'),
    countText: tr(
      `${fmtNum(results.length)} ${results.length === 1 ? 'result' : 'results'} for “${state.query.trim()}”`,
      `${fmtNum(results.length)} ${results.length === 1 ? 'resultado' : 'resultados'} para “${state.query.trim()}”`,
    ),
  });
  if (!nodes.length) {
    emptyState({
      icon: 'search',
      title: tr('No results', 'Sin resultados'),
      msg: tr('Try different words or check the spelling. Tip: site:github.com, in:dev, is:folder, -word.', 'Prueba con otras palabras o revisa la ortografía. Truco: site:github.com, in:dev, is:folder, -palabra.'),
    });
    return;
  }
  renderLimited(nodes, { tokens, showPath: true });
}

// ============ Limpieza: duplicados, carpetas vacías y enlaces rotos ============
function renderCleanupView() {
  const groups = dupeGroups();
  const extras = groups.reduce((n, g) => n + g.length - 1, 0);
  const empties = emptyFolders();
  const problems = linkReport ? linkProblemGroups().reduce((n, g) => n + g.items.length, 0) : null;
  const tabs = el('div', { class: 'cleanup-tabs', role: 'group', 'aria-label': tr('Cleanup tools', 'Herramientas de limpieza') });
  for (const [id, label, ic, count] of [
    ['dupes', tr('Duplicates', 'Duplicados'), 'copy', extras],
    ['empty', tr('Empty folders', 'Carpetas vacías'), 'folderX', empties.length],
    ['links', tr('Broken links', 'Enlaces rotos'), 'unlink', linkRun ? '…' : problems],
  ]) {
    tabs.append(el('button', {
      class: 'filter-chip', 'aria-pressed': String(state.cleanupTab === id),
      onClick: () => { state.cleanupTab = id; savePref('mp-cleanup-tab', id); clearSelection({ silent: true }); renderContent(); },
    }, el('span', { class: 'icn', html: svg(ic, 13) }), label, count ? el('span', { class: 'chip-count', text: typeof count === 'number' ? fmtNum(count) : count }) : null));
  }
  content.append(tabs);
  if (state.cleanupTab === 'empty') renderEmptyFolders(empties);
  else if (state.cleanupTab === 'links') renderLinkCheck();
  else renderDupes(groups, extras);
}

function renderDupes(groups, extras) {
  const actions = [];
  if (groups.length) {
    const b = el('button', { class: 'btn danger', html: svg('trash', 15) }, tr(` Clean duplicates (${extras})`, ` Limpiar duplicados (${extras})`));
    b.addEventListener('click', async () => {
      const ok = await modalConfirm({
        title: tr(
          `Remove ${extras} ${extras === 1 ? 'duplicate' : 'duplicates'}?`,
          `¿Eliminar ${extras} ${extras === 1 ? 'duplicado' : 'duplicados'}?`,
        ),
        msg: tr('The oldest bookmark in each group will be kept. You can undo this afterward.', 'Se conserva el marcador más antiguo de cada grupo. Puedes deshacerlo después.'),
        confirmLabel: tr('Clean', 'Limpiar'),
      });
      if (ok) deleteNodes(groups.flatMap((g) => sortByAge(g).slice(1).map((n) => n.id)), { skipConfirm: true });
    });
    actions.push(b);
  }
  setHead({
    title: tr('Cleanup', 'Limpieza'),
    countText: groups.length ? tr(
      `${fmtNum(groups.length)} ${groups.length === 1 ? 'repeated URL' : 'repeated URLs'} · ${fmtNum(extras)} extra`,
      `${fmtNum(groups.length)} ${groups.length === 1 ? 'URL repetida' : 'URLs repetidas'} · ${fmtNum(extras)} de más`,
    ) : '',
    actions,
  });
  if (!groups.length) {
    emptyState({
      icon: 'sparkles',
      title: tr('All clean!', '¡Todo limpio!'),
      msg: tr('There are no duplicate bookmarks in your collection.', 'No hay marcadores duplicados en tu colección.'),
    });
    return;
  }
  for (const g of groups) {
    const ordered = sortByAge(g);
    const keepBtn = el('button', { class: 'btn ghost', style: 'height:28px;font-size:12px' }, tr('Keep only the oldest', 'Dejar solo el más antiguo'));
    keepBtn.addEventListener('click', () => deleteNodes(ordered.slice(1).map((n) => n.id), { skipConfirm: true }));
    const box = el('div', { class: 'dupe-group' },
      el('div', { class: 'dupe-head' },
        faviconEl(g[0].url, 18),
        el('span', { class: 'url', text: g[0].url, title: g[0].url }),
        keepBtn,
      ));
    const listWrap = el('div', { class: 'list' });
    for (const n of ordered) {
      listWrap.append(rowEl(n, { showPath: true }));
      state.items.push(n);
    }
    box.append(listWrap);
    content.append(box);
  }
}

function renderEmptyFolders(empties) {
  const actions = [];
  if (empties.length) {
    actions.push(el('button', {
      class: 'btn danger', html: svg('trash', 15),
      onClick: () => deleteNodes(empties.map(f => f.id), { skipConfirm: true }),
    }, tr(` Delete empty folders (${empties.length})`, ` Eliminar carpetas vacías (${empties.length})`)));
  }
  setHead({
    title: tr('Cleanup', 'Limpieza'),
    countText: empties.length ? tr(
      `${fmtNum(empties.length)} ${empties.length === 1 ? 'folder' : 'folders'} without bookmarks`,
      `${fmtNum(empties.length)} ${empties.length === 1 ? 'carpeta' : 'carpetas'} sin marcadores`,
    ) : '',
    actions,
  });
  if (!empties.length) {
    emptyState({ icon: 'sparkles', title: tr('No empty folders', 'No hay carpetas vacías'), msg: tr('Every folder has at least one bookmark.', 'Todas las carpetas tienen al menos un marcador.') });
    return;
  }
  content.append(el('p', { class: 'cleanup-note', text: tr('These folders (and any subfolders) contain no bookmarks. Deleting them can be undone.', 'Estas carpetas (y sus subcarpetas) no contienen marcadores. Eliminarlas se puede deshacer.') }));
  const wrap = el('div', { class: 'list' });
  for (const f of empties) { wrap.append(rowEl(f, { showPath: true })); state.items.push(f); }
  content.append(wrap);
}

// Cruza el último informe con los marcadores actuales (los borrados o editados desaparecen solos)
function linkProblemGroups() {
  const byKey = new Map();
  for (const n of allBookmarks) {
    const k = urlKey(n.url);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }
  const groups = { broken: [], redirect: [], unverified: [] };
  for (const p of linkReport?.problems || []) {
    for (const node of byKey.get(urlKey(p.url)) || []) groups[p.kind]?.push({ node, problem: p });
  }
  return [
    { kind: 'broken', title: tr('Not found', 'No encontrados'), hint: tr('The page no longer exists or the site does not respond.', 'La página ya no existe o el sitio no responde.'), items: groups.broken },
    { kind: 'redirect', title: tr('Moved', 'Se mudaron'), hint: tr('The address now redirects somewhere else. You can update it.', 'La dirección ahora redirige a otra. Puedes actualizarla.'), items: groups.redirect },
    { kind: 'unverified', title: tr('Could not verify', 'No se pudieron verificar'), hint: tr('They may require signing in or block automatic checks. Open them to confirm.', 'Pueden requerir iniciar sesión o bloquear revisiones automáticas. Ábrelos para confirmar.'), items: groups.unverified },
  ].filter(g => g.items.length);
}

function problemLabel(p) {
  if (p.kind === 'redirect') return '→ ' + p.finalUrl;
  if (p.reason === 'timeout') return tr('No response (timed out)', 'Sin respuesta (tiempo agotado)');
  if (p.reason === 'network') return tr('Site unreachable or domain not found', 'Sitio inaccesible o dominio inexistente');
  const names = { 404: tr('Not found', 'No encontrado'), 410: tr('Gone', 'Eliminado'), 401: tr('Sign-in required', 'Requiere iniciar sesión'), 403: tr('Access denied', 'Acceso denegado'), 429: tr('Too many requests', 'Demasiadas solicitudes') };
  return `${p.status} · ${names[p.status] || (p.status >= 500 ? tr('Server error', 'Error del servidor') : tr('Unexpected response', 'Respuesta inesperada'))}`;
}

function renderLinkCheck() {
  const httpCount = new Set(allBookmarks.filter(b => /^https?:/i.test(b.url)).map(b => b.url)).size;
  if (linkRun) {
    setHead({
      title: tr('Cleanup', 'Limpieza'), countText: tr('Checking links…', 'Revisando enlaces…'),
      actions: [btnGhost('x', tr('Stop', 'Detener'), () => { linkRun.cancelled = true; })],
    });
    const pct = linkRun.total ? Math.round((linkRun.done / linkRun.total) * 100) : 0;
    content.append(el('div', { class: 'link-progress' },
      el('div', { class: 'lp-text', id: 'linkProgressText', text: progressText() }),
      el('div', { class: 'lp-bar' }, el('span', { id: 'linkProgressBar', style: `width:${pct}%` })),
      el('p', { class: 'cleanup-note', text: tr('You can keep using Mark My Tabs while the check runs.', 'Puedes seguir usando Mark My Tabs mientras termina la revisión.') })));
    return;
  }
  const label = linkReport ? tr('Check again', 'Volver a revisar') : tr(`Check ${fmtNum(httpCount)} links`, `Revisar ${fmtNum(httpCount)} enlaces`);
  const start = btnPrimary('refresh', label, startLinkCheck);
  if (!httpCount) start.disabled = true;
  setHead({
    title: tr('Cleanup', 'Limpieza'),
    countText: linkReport ? tr(`${fmtNum(linkReport.total)} links checked ${timeAgo(linkReport.checkedAt)}`, `${fmtNum(linkReport.total)} enlaces revisados ${timeAgo(linkReport.checkedAt)}`) : '',
    actions: [start],
  });
  if (!linkReport) {
    content.append(el('div', { class: 'empty' },
      el('div', { class: 'art', html: svg('unlink', 34) }),
      el('h3', { text: tr('Find links that no longer work', 'Encuentra enlaces que ya no funcionan') }),
      el('p', { text: tr('Mark My Tabs visits each saved address to see whether it still responds. Chrome will ask for permission once. Requests go straight to each site, without cookies, and nothing is sent anywhere else.', 'Mark My Tabs visita cada dirección guardada para ver si sigue respondiendo. Chrome te pedirá permiso una sola vez. Las consultas van directo a cada sitio, sin cookies, y no se envía nada a ningún otro lado.') })));
    return;
  }
  const groups = linkProblemGroups();
  if (!groups.length) {
    emptyState({ icon: 'sparkles', title: tr('Every link responds', 'Todos los enlaces responden'), msg: tr('No broken or moved links were found in the last check.', 'La última revisión no encontró enlaces rotos ni mudados.') });
    return;
  }
  for (const g of groups) {
    const head = el('div', { class: 'link-group-head' },
      el('div', {}, el('h3', { text: `${g.title} · ${fmtNum(g.items.length)}` }), el('p', { text: g.hint })));
    if (g.kind === 'broken') {
      head.append(el('button', { class: 'btn danger', html: svg('trash', 15),
        onClick: () => deleteNodes(g.items.map(i => i.node.id), { skipConfirm: true }) }, tr(` Delete all (${g.items.length})`, ` Eliminar todos (${g.items.length})`)));
    }
    if (g.kind === 'redirect') {
      head.append(el('button', { class: 'btn', html: svg('refresh', 15), onClick: () => applyRedirects(g.items) }, tr(` Update all (${g.items.length})`, ` Actualizar todos (${g.items.length})`)));
    }
    content.append(head);
    const listWrap = el('div', { class: 'list link-list' });
    for (const { node, problem } of g.items) {
      const detail = el('div', { class: `link-detail ${g.kind}` }, el('span', { class: 'why', text: problemLabel(problem), title: problem.finalUrl || '' }));
      if (g.kind === 'redirect') detail.append(el('button', { class: 'btn ghost sm', text: tr('Use new address', 'Usar nueva dirección'), onClick: () => applyRedirects([{ node, problem }]) }));
      listWrap.append(el('div', { class: 'link-item' }, rowEl(node, { showPath: true }), detail));
      state.items.push(node);
    }
    content.append(listWrap);
  }
}

function progressText() {
  if (!linkRun) return '';
  return tr(
    `Checked ${fmtNum(linkRun.done)} of ${fmtNum(linkRun.total)} · ${fmtNum(linkRun.problems.length)} with problems`,
    `Revisados ${fmtNum(linkRun.done)} de ${fmtNum(linkRun.total)} · ${fmtNum(linkRun.problems.length)} con problemas`,
  );
}

let progressFrame = 0;
function updateLinkProgress() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    const text = $('#linkProgressText'), bar = $('#linkProgressBar');
    if (text) text.textContent = progressText();
    if (bar && linkRun) bar.style.width = `${Math.round((linkRun.done / Math.max(1, linkRun.total)) * 100)}%`;
  });
}

async function startLinkCheck() {
  if (linkRun) return;
  // permissions.request debe ejecutarse dentro del gesto del usuario: va primero.
  if (IS_EXT) {
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).catch(() => false);
    if (!granted) { toast(tr('Link checking needs permission to visit your saved sites.', 'Para revisar enlaces hace falta permiso para visitar tus sitios guardados.'), { kind: 'info', icon: 'info' }); return; }
  }
  if (!navigator.onLine) { toast(tr('You seem to be offline. Connect and try again.', 'Parece que no hay conexión. Conéctate y vuelve a intentarlo.'), { kind: 'err', icon: 'alert' }); return; }
  const urls = [...new Set(allBookmarks.filter(b => /^https?:/i.test(b.url)).map(b => b.url))];
  const run = { done: 0, total: urls.length, problems: [], cancelled: false };
  linkRun = run;
  if (state.view.type === 'cleanup') renderContent();
  await checkLinks(urls, {
    mock: !IS_EXT,
    shouldStop: () => run.cancelled,
    onResult(url, result) {
      run.done++;
      if (result.kind !== 'ok') run.problems.push({ url, ...result });
      updateLinkProgress();
    },
  });
  linkRun = null;
  const networkFailures = run.problems.filter(p => p.reason === 'network').length;
  if (run.done >= 10 && networkFailures / run.done > .9) {
    toast(tr('Almost no site responded. Check your connection and try again.', 'Casi ningún sitio respondió. Revisa tu conexión y vuelve a intentarlo.'), { kind: 'err', icon: 'alert', duration: 8000 });
  } else if (!run.cancelled) {
    linkReport = { checkedAt: Date.now(), total: run.total, problems: run.problems };
    await saveLinkReport(linkReport);
    const found = run.problems.length;
    toast(found
      ? tr(`Check finished: ${fmtNum(found)} ${found === 1 ? 'link needs' : 'links need'} attention`, `Revisión terminada: ${fmtNum(found)} ${found === 1 ? 'enlace necesita' : 'enlaces necesitan'} atención`)
      : tr('Check finished: every link responds', 'Revisión terminada: todos los enlaces responden'), {
      icon: found ? 'unlink' : 'sparkles', duration: 6000,
      ...(state.view.type !== 'cleanup' ? { actionLabel: tr('View', 'Ver'), onAction: () => { state.cleanupTab = 'links'; setView({ type: 'cleanup' }); } } : {}),
    });
  }
  if (state.view.type === 'cleanup' && !searching()) renderContent();
}

async function applyRedirects(items) {
  const done = [];
  try {
    for (const { node, problem } of items) {
      await bm.update(node.id, { url: problem.finalUrl });
      done.push({ id: node.id, url: node.url });
    }
  } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); }
  if (!done.length) return;
  const fixed = new Set(items.map(i => i.problem.url));
  linkReport.problems = linkReport.problems.filter(p => !(p.kind === 'redirect' && fixed.has(p.url)));
  await saveLinkReport(linkReport);
  toast(done.length === 1 ? tr('Address updated', 'Dirección actualizada') : tr(`${done.length} addresses updated`, `${done.length} direcciones actualizadas`), {
    icon: 'refresh', undo: async () => { for (const d of done) await bm.update(d.id, { url: d.url }); },
  });
}

const sortByAge = (g) => g.slice().sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));

function renderLimited(nodes, opts) {
  renderItems(content, nodes.slice(0, state.limit), opts);
  if (nodes.length > state.limit) {
    const rest = nodes.length - state.limit;
    content.append(el('div', { style: 'display:flex;justify-content:center;padding:18px' },
      el('button', { class: 'btn', text: tr(`Show ${fmtNum(Math.min(400, rest))} more`, `Mostrar ${fmtNum(Math.min(400, rest))} más`), onClick: () => { state.limit += 400; renderContent(); } })));
  }
}

function renderItems(container, nodes, opts = {}) {
  const wrap = el('div', { class: state.layout === 'grid' ? 'grid' : 'list' });
  for (const n of nodes) {
    wrap.append(state.layout === 'grid' ? cardEl(n, opts) : rowEl(n, opts));
    state.items.push(n);
  }
  container.append(wrap);
}

function btnPrimary(iconName, label, onClick) {
  return el('button', { class: 'btn primary', html: svg(iconName, 15), onClick }, ` ${label}`);
}

function btnGhost(iconName, label, onClick) {
  const b = el('button', { class: 'btn ghost', html: svg(iconName, 15) }, ` ${label}`);
  b.addEventListener('click', onClick);
  return b;
}

function emptyState({ icon: ic, title, msg, action }) {
  content.append(el('div', { class: 'empty' },
    el('div', { class: 'art', html: svg(ic, 34) }),
    el('h3', { text: title }),
    msg ? el('p', { text: msg }) : null,
    action ? el('button', { class: 'btn primary', text: action.label, onClick: action.onClick }) : null,
  ));
}

// ============ Elementos (card / fila) ============
function selCheckEl() {
  return el('button', { class: 'sel-check', title: tr('Select', 'Seleccionar'), html: svg('check', 13), tabindex: '-1' });
}

function menuBtnEl(cls) {
  return el('button', { class: cls, html: svg('more', 15), title: tr('Options', 'Opciones'), tabindex: '-1' });
}

function pathChip(node) {
  const parts = pathOf(node).map((f) => f.title || tr('Untitled', 'Sin nombre'));
  if (!parts.length) return null;
  const chip = el('button', { class: 'path-chip', title: tr('Go to folder', 'Ir a la carpeta') },
    el('span', { class: 'icn', html: svg('folder', 11) }),
    el('span', { text: parts.join(' / ') }));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    setView({ type: 'folder', folderId: node.parentId });
  });
  return chip;
}

function cardEl(node, { tokens, showPath } = {}) {
  const isFolder = !node.url;
  const card = el('div', {
    class: `card${isFolder ? ' is-folder' : ''}`,
    tabindex: '0', role: isFolder ? 'button' : 'link',
    dataset: { id: node.id }, draggable: 'true',
    title: isFolder ? (node.title || tr('Untitled', 'Sin nombre')) : `${node.title || ''}\n${node.url}`,
  });
  const c = isFolder ? (countsById.get(node.id) || { b: 0 }) : null;
  card.append(
    selCheckEl(),
    el('div', { class: 'tile' }, isFolder ? el('span', { class: 'icn', html: svg('folder', 22) }) : faviconEl(node.url, 24)),
    el('div', { class: 'meta' },
      el('div', { class: 'title', html: highlight(node.title || (isFolder ? tr('Untitled', 'Sin nombre') : domainOf(node.url)), tokens) }),
      el('div', { class: 'sub', text: isFolder ? `${fmtNum(c.b)} ${c.b === 1 ? tr('bookmark', 'marcador') : tr('bookmarks', 'marcadores')}` : domainOf(node.url) }),
      showPath ? pathChip(node) : null,
    ),
    menuBtnEl('icon-btn card-menu'),
  );
  return card;
}

function rowEl(node, { tokens, showPath } = {}) {
  const isFolder = !node.url;
  const c = isFolder ? (countsById.get(node.id) || { b: 0 }) : null;
  return el('div', {
    class: 'item-row', tabindex: '0', role: isFolder ? 'button' : 'link',
    dataset: { id: node.id }, draggable: 'true',
    title: isFolder ? (node.title || tr('Untitled', 'Sin nombre')) : `${node.title || ''}\n${node.url}`,
  },
    selCheckEl(),
    isFolder
      ? el('span', { class: 'row-icn', html: svg('folder', 18) })
      : faviconEl(node.url, 18),
    el('span', { class: 'title', html: highlight(node.title || (isFolder ? tr('Untitled', 'Sin nombre') : domainOf(node.url)), tokens) }),
    showPath ? pathChip(node) : null,
    el('span', { class: 'domain', text: isFolder ? `${fmtNum(c.b)} ${c.b === 1 ? tr('bookmark', 'marcador') : tr('bookmarks', 'marcadores')}` : domainOf(node.url) }),
    el('span', { class: 'date', text: timeAgo(node.dateAdded), title: fullDate(node.dateAdded) }),
    menuBtnEl('icon-btn sm row-menu'),
  );
}

const itemEls = () => $$('[data-id].card, [data-id].item-row', content);

// ============ Selección ============
function clearSelection({ silent = false } = {}) {
  state.selection.clear();
  state.anchorIndex = null;
  if (!silent) syncSelectionUI();
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.anchorIndex = state.items.findIndex((n) => n.id === id);
  syncSelectionUI();
}

function rangeSelect(id) {
  const idx = state.items.findIndex((n) => n.id === id);
  if (state.anchorIndex == null || idx === -1) { toggleSelect(id); return; }
  const [a, b] = [Math.min(state.anchorIndex, idx), Math.max(state.anchorIndex, idx)];
  for (let i = a; i <= b; i++) state.selection.add(state.items[i].id);
  syncSelectionUI();
}

function selectAll() {
  for (const n of state.items) state.selection.add(n.id);
  syncSelectionUI();
}

function syncSelectionUI() {
  content.classList.toggle('selecting', state.selection.size > 0);
  for (const elm of itemEls()) elm.classList.toggle('selected', state.selection.has(elm.dataset.id));
  renderBulkbar();
}

function renderBulkbar() {
  const bar = $('#bulkbar');
  const n = state.selection.size;
  if (!n) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  const nodes = [...state.selection].map((id) => nodeById.get(id)).filter(Boolean);
  const urls = nodes.filter((x) => x.url).map((x) => x.url);
  const open = btnGhost('external', tr('Open', 'Abrir'), () => openAll(urls));
  if (!urls.length) open.setAttribute('disabled', '');
  bar.append(
    el('span', { class: 'count', text: `${n} ${n === 1 ? tr('selected', 'seleccionado') : tr('selected', 'seleccionados')}` }),
    open,
    btnGhost('folder', tr('Move', 'Mover'), () => modalMove([...state.selection])),
    btnGhost('copy', tr('Copy', 'Copiar'), () => copyText(
      urls.join('\n'),
      urls.length === 1 ? tr('Link copied', 'Enlace copiado') : tr(`${urls.length} links copied`, `${urls.length} enlaces copiados`),
    )),
    (() => {
      const b = el('button', { class: 'btn danger', html: svg('trash', 15) }, tr(' Delete', ' Eliminar'));
      b.addEventListener('click', () => deleteNodes([...state.selection]));
      return b;
    })(),
    el('button', { class: 'icon-btn', html: svg('x', 16), title: tr('Deselect (Esc)', 'Deseleccionar (Esc)'), onClick: () => clearSelection() }),
  );
}

// ============ Acciones ============
async function openAll(urls, opts = {}) {
  if (!urls.length) return;
  if (urls.length > 15) {
    const ok = await modalConfirm({
      title: tr(`Open ${urls.length} tabs?`, `¿Abrir ${urls.length} pestañas?`),
      msg: tr('Many tabs will open at once.', 'Se van a abrir muchas pestañas a la vez.'),
      confirmLabel: tr('Open all', 'Abrir todas'),
      danger: false,
    });
    if (!ok) return;
  }
  try { await openUrls(urls, opts); }
  catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); return; }
  toast(opts.group
    ? tr(`Tab group “${opts.group}” opened`, `Grupo de pestañas «${opts.group}» abierto`)
    : `${urls.length} ${urls.length === 1 ? tr('tab opened', 'pestaña abierta') : tr('tabs opened', 'pestañas abiertas')}`, { icon: opts.group ? 'layers' : 'external' });
}

// Ordena de verdad la carpeta en Chrome (carpetas primero), con deshacer.
async function sortFolderByName(folder) {
  const children = await bm.getChildren(folder.id);
  const original = children.map(c => c.id);
  const sorted = [...children.filter(c => !c.url).sort(cmpTitle), ...children.filter(c => c.url).sort(cmpTitle)].map(c => c.id);
  const name = folder.title || tr('Untitled', 'Sin nombre');
  if (sorted.every((id, i) => id === original[i])) { toast(tr(`“${name}” is already sorted`, `«${name}» ya está ordenada`), { icon: 'check' }); return; }
  try { await applyOrder(folder.id, sorted); }
  catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); return; }
  toast(tr(`“${name}” sorted by name`, `«${name}» ordenada por nombre`), { icon: 'sortAZ', undo: () => applyOrder(folder.id, original) });
}

async function applyOrder(parentId, ids) {
  const current = new Set((await bm.getChildren(parentId)).map(c => c.id));
  const order = ids.filter(id => current.has(id));
  // Recorriendo de arriba hacia abajo cada elemento sube a su lugar, sin el desfase de índices de Chrome.
  for (let i = 0; i < order.length; i++) await bm.move(order[i], { parentId, index: i });
}

// Crea marcadores a partir de URLs pegadas o arrastradas desde otra pestaña.
async function addUrls(items, parentId) {
  const created = [];
  try {
    for (const it of items) created.push((await bm.create({ parentId, title: it.title || domainOf(it.url), url: it.url })).id);
  } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); }
  if (!created.length) return;
  const dest = nodeById.get(parentId)?.title || '';
  toast(created.length === 1
    ? tr(`Bookmark added to “${dest}”`, `Marcador agregado a «${dest}»`)
    : tr(`${created.length} bookmarks added to “${dest}”`, `${created.length} marcadores agregados a «${dest}»`), {
    icon: 'bookmark', undo: async () => { for (const id of created) await bm.remove(id); },
  });
}

function urlsFromText(text) {
  return [...new Set(String(text).split(/\s+/)
    .filter(s => /^(https?|ftp|file):/i.test(s))
    .map(s => normalizeUrl(s, { addScheme: false })).filter(Boolean))];
}

const isLinkDrag = (e) => !draggingIds && [...(e.dataTransfer?.types || [])].includes('text/uri-list');

function linksFromDrop(dt) {
  const titles = new Map();
  const html = dt.getData('text/html');
  if (html) {
    for (const a of new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')) {
      const url = normalizeUrl(a.getAttribute('href'), { addScheme: false });
      const title = a.textContent.trim().replace(/\s+/g, ' ');
      if (url && title && !titles.has(url)) titles.set(url, title.slice(0, 500));
    }
  }
  const urls = (dt.getData('text/uri-list') || '').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  return [...new Set(urls.map(u => normalizeUrl(u, { addScheme: false })).filter(Boolean))]
    .map(url => ({ url, title: titles.get(url) }));
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg, { icon: 'copy' }); }
  catch { toast(tr('Could not copy to the clipboard', 'No se pudo copiar al portapapeles'), { kind: 'err', icon: 'alert' }); }
}

async function moveNodesTo(ids, parentId, index) {
  const list = topLevelOnly(ids.filter((id) => nodeById.has(id)));
  if (!list.length) return false;
  if (list.some((id) => isRootFolder(nodeById.get(id)))) {
    toast(tr('Top-level folders cannot be moved', 'Las carpetas principales no se pueden mover'), { kind: 'err', icon: 'alert' });
    return false;
  }
  const records = list.map((id) => {
    const n = nodeById.get(id);
    return { id, parentId: n.parentId, index: n.index ?? 0 };
  });
  const sameParentReorder = index != null;
  let pos = index;
  try {
    for (const id of list) {
      await bm.move(id, { parentId, ...(pos != null ? { index: pos++ } : {}) });
    }
  } catch (err) {
    toast(errMsg(err), { kind: 'err', icon: 'alert' });
    return false;
  }
  clearSelection({ silent: true });
  if (!sameParentReorder || records.some((r) => r.parentId !== parentId)) {
    const dest = nodeById.get(parentId);
    toast(tr(
      `${list.length === 1 ? 'Moved' : `${list.length} items moved`} to “${dest?.title || 'folder'}”`,
      `${list.length === 1 ? 'Movido' : `${list.length} elementos movidos`} a “${dest?.title || 'carpeta'}”`,
    ), {
      icon: 'folder', undo: () => undoMoves(records),
    });
    noteFolder(parentId);
  }
  return true;
}

async function undoMoves(records) {
  const sorted = [...records].sort((a, b) => (a.parentId === b.parentId ? a.index - b.index : 0));
  for (const r of sorted) await bm.move(r.id, { parentId: r.parentId, index: r.index });
}

async function deleteNodes(ids, { skipConfirm = false } = {}) {
  const list = topLevelOnly(ids.filter((id) => nodeById.has(id)));
  if (!list.length) return;
  if (list.some((id) => isRootFolder(nodeById.get(id)))) {
    toast(tr('Top-level folders cannot be deleted', 'Las carpetas principales no se pueden eliminar'), { kind: 'err', icon: 'alert' });
    return;
  }
  const folders = list.filter((id) => !nodeById.get(id).url);
  if (folders.length && !skipConfirm) {
    const inside = folders.reduce((n, id) => n + (countsById.get(id)?.b || 0), 0);
    const single = list.length === 1 && folders.length === 1;
    const ok = await modalConfirm({
      title: tr(
        single ? `Delete the folder “${nodeById.get(folders[0]).title || 'Untitled'}”?` : `Delete ${list.length} items?`,
        single ? `¿Eliminar la carpeta “${nodeById.get(folders[0]).title || 'Sin nombre'}”?` : `¿Eliminar ${list.length} elementos?`,
      ),
      msg: inside
        ? tr(
          `${inside === 1 ? '1 saved bookmark' : `${fmtNum(inside)} saved bookmarks`} inside will also be deleted. You can undo this.`,
          `También se ${inside === 1 ? 'eliminará 1 marcador guardado' : `eliminarán ${fmtNum(inside)} marcadores guardados`} adentro. Vas a poder deshacerlo.`,
        )
        : tr('You can undo this from the notification.', 'Vas a poder deshacerlo desde el aviso.'),
      confirmLabel: tr('Delete', 'Eliminar'),
    });
    if (!ok) return;
  }
  const records = [];
  try {
    for (const id of list) {
      const n = nodeById.get(id);
      const [sub] = await bm.getSubTree(id);
      records.push({ parentId: n.parentId, index: n.index ?? 0, sub });
    }
    records.sort((a, b) => (a.parentId === b.parentId ? a.index - b.index : 0));
    for (const id of list) {
      const n = nodeById.get(id);
      await (n.url ? bm.remove(id) : bm.removeTree(id));
    }
  } catch (err) {
    toast(errMsg(err), { kind: 'err', icon: 'alert' });
    return;
  }
  clearSelection({ silent: true });
  toast(
    list.length === 1 ? tr('Deleted', 'Eliminado') : tr(`${list.length} items deleted`, `${list.length} elementos eliminados`),
    { icon: 'trash', kind: 'info', undo: () => restoreRecords(records) },
  );
}

async function restoreRecords(records) {
  for (const r of records) await recreate(r.sub, r.parentId, r.index);
}

async function recreate(node, parentId, index) {
  if (node.url) {
    await bm.create({ parentId, ...(index != null ? { index } : {}), title: node.title, url: node.url });
    return;
  }
  const created = await bm.create({ parentId, ...(index != null ? { index } : {}), title: node.title });
  for (const c of node.children || []) await recreate(c, created.id, null);
}

// ============ Drag & drop ============
let draggingIds = null;
let dropTarget = null;
let dropMode = null;

const reorderAllowed = () => !searching() && state.view.type === 'folder' && state.sort === 'manual';

function clearDropMarkers() {
  content.classList.remove('drop-external');
  for (const x of $$('.drop-into, .drop-marker')) x.classList.remove('drop-into', 'drop-marker', 'before', 'after');
  dropTarget = null;
  dropMode = null;
}

content.addEventListener('dragstart', (e) => {
  const item = e.target.closest?.('[data-id]');
  if (!item) return;
  const id = item.dataset.id;
  draggingIds = state.selection.has(id) && state.selection.size > 0 ? topLevelOnly([...state.selection]) : [id];
  e.dataTransfer.effectAllowed = 'move';
  try {
    e.dataTransfer.setData('text/plain', draggingIds.map((i) => nodeById.get(i)?.url || nodeById.get(i)?.title || '').join('\n'));
  } catch { /* */ }
  requestAnimationFrame(() => {
    for (const elm of itemEls()) if (draggingIds?.includes(elm.dataset.id)) elm.classList.add('dragging');
  });
});

content.addEventListener('dragend', () => {
  draggingIds = null;
  clearDropMarkers();
  for (const x of $$('.dragging', content)) x.classList.remove('dragging');
});

content.addEventListener('dragover', (e) => {
  if (isLinkDrag(e)) {
    const folderEl = e.target.closest?.('[data-id]');
    const folderNode = folderEl && nodeById.get(folderEl.dataset.id);
    clearDropMarkers();
    if (folderNode && !folderNode.url) folderEl.classList.add('drop-into');
    else if (!searching() && state.view.type === 'folder') content.classList.add('drop-external');
    else return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    return;
  }
  if (!draggingIds) return;
  const item = e.target.closest?.('[data-id]');
  clearDropMarkers();
  if (!item || draggingIds.includes(item.dataset.id)) return;
  const node = nodeById.get(item.dataset.id);
  if (!node) return;
  const isFolder = !node.url;
  const canReorder = reorderAllowed();
  const rect = item.getBoundingClientRect();
  const horiz = state.layout === 'grid';
  const t = horiz ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
  let mode = null;
  if (isFolder && !draggingIds.some((id) => id === node.id || isDescendant(node.id, id))) {
    mode = canReorder ? (t < .28 ? 'before' : t > .72 ? 'after' : 'into') : 'into';
  } else if (canReorder) {
    mode = t < .5 ? 'before' : 'after';
  }
  if (!mode) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropTarget = item.dataset.id;
  dropMode = mode;
  if (mode === 'into') item.classList.add('drop-into');
  else item.classList.add('drop-marker', mode);
});

content.addEventListener('dragleave', (e) => {
  if (!content.contains(e.relatedTarget)) clearDropMarkers();
});

content.addEventListener('drop', (e) => {
  e.preventDefault();
  if (isLinkDrag(e)) {
    const folderEl = e.target.closest?.('[data-id]');
    const folderNode = folderEl && nodeById.get(folderEl.dataset.id);
    const parentId = folderNode && !folderNode.url ? folderNode.id : (!searching() && state.view.type === 'folder' ? state.view.folderId : null);
    clearDropMarkers();
    const links = linksFromDrop(e.dataTransfer);
    if (parentId && links.length) addUrls(links, parentId);
    return;
  }
  const ids = draggingIds;
  const target = dropTarget;
  const mode = dropMode;
  draggingIds = null;
  clearDropMarkers();
  if (!ids?.length || !target || !mode) return;
  if (mode === 'into') { moveNodesTo(ids, target, null); return; }
  reorderDrop(ids, target, mode === 'before');
});

async function reorderDrop(ids, targetId, before) {
  const parentId = state.view.folderId;
  try {
    const children = await bm.getChildren(parentId);
    const dragSet = new Set(ids);
    const order = children.map((c) => c.id).filter((id) => !dragSet.has(id));
    let pos = order.indexOf(targetId);
    if (pos === -1) pos = order.length;
    else if (!before) pos += 1;
    await moveNodesTo(ids, parentId, pos);
  } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); }
}

// ============ Menú contextual ============
let menuOpen = false;
let menuReturnFocus = null;

function showMenu(x, y, items) {
  menuReturnFocus = document.activeElement;
  const menu = $('#ctxMenu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.append(el('div', { class: 'menu-sep' })); continue; }
    if (it.title) { menu.append(el('div', { class: 'menu-title', text: it.title })); continue; }
    const b = el('button', {
      class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem',
      disabled: it.disabled ? true : null,
    },
      el('span', { class: 'icn', html: svg(it.icon || 'chevron', 16) }),
      el('span', { class: 'label', text: it.label }),
      it.hint ? el('span', { class: 'hint', text: it.hint }) : null,
      it.checked ? el('span', { class: 'icn', html: svg('check', 14) }) : null);
    b.addEventListener('click', () => { hideMenu(); it.onClick?.(); });
    menu.append(b);
  }
  menu.hidden = false;
  menuOpen = true;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function hideMenu() {
  const menu = $('#ctxMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  menuOpen = false;
  if (menu.contains(document.activeElement) && menuReturnFocus?.isConnected) menuReturnFocus.focus({ preventScroll: true });
}

$('#ctxMenu').addEventListener('keydown', e => {
  const items = $$('.menu-item:not(:disabled)', $('#ctxMenu'));
  const index = items.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation();
    items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
  if (e.key === 'Tab') hideMenu();
});

function bookmarkMenuItems(node) {
  return [
    { label: tr('Open in new tab', 'Abrir en pestaña nueva'), icon: 'external', onClick: () => openUrl(node.url) },
    { label: tr('Open in background', 'Abrir en segundo plano'), icon: 'arrowUpRight', onClick: () => openUrl(node.url, { active: false }) },
    { label: tr('Open in new window', 'Abrir en ventana nueva'), icon: 'window', onClick: () => openInWindow(node.url) },
    '-',
    { label: tr('Edit', 'Editar'), icon: 'pen', hint: 'F2', onClick: () => modalBookmark(node) },
    { label: tr('Copy link', 'Copiar enlace'), icon: 'copy', onClick: () => copyText(node.url, tr('Link copied', 'Enlace copiado')) },
    { label: tr('Copy as Markdown', 'Copiar como Markdown'), icon: 'link', onClick: () => copyText(`[${(node.title || domainOf(node.url)).replace(/[[\]]/g, '\\$&')}](${node.url})`, tr('Markdown link copied', 'Enlace Markdown copiado')) },
    { label: tr('Move to…', 'Mover a…'), icon: 'folder', onClick: () => modalMove([node.id]) },
    '-',
    { label: tr('Delete', 'Eliminar'), icon: 'trash', danger: true, hint: tr('Del', 'Supr'), onClick: () => deleteNodes([node.id]) },
  ];
}

function folderMenuItems(node) {
  const isRoot = isRootFolder(node);
  const c = countsById.get(node.id) || { b: 0 };
  return [
    { label: state.pinned.has(node.id) ? tr('Unpin folder', 'Desfijar carpeta') : tr('Pin folder', 'Fijar carpeta'), icon: 'pin', onClick: () => togglePinned(node.id) },
    { label: tr('Open folder', 'Abrir carpeta'), icon: 'folderOpen', onClick: () => setView({ type: 'folder', folderId: node.id }) },
    { label: tr(`Open all (${fmtNum(c.b)})`, `Abrir todos (${fmtNum(c.b)})`), icon: 'external', disabled: !c.b, onClick: () => openAll(collectUrls(node)) },
    { label: tr('Open as tab group', 'Abrir como grupo de pestañas'), icon: 'layers', disabled: !c.b, onClick: () => openAll(collectUrls(node), { group: node.title || tr('Bookmarks', 'Marcadores') }) },
    { label: tr('Open all in new window', 'Abrir todos en ventana nueva'), icon: 'window', disabled: !c.b, onClick: () => openAll(collectUrls(node), { newWindow: true }) },
    '-',
    { label: tr('New bookmark', 'Nuevo marcador'), icon: 'plus', onClick: () => modalBookmark(null, { parentId: node.id }) },
    { label: tr('New subfolder', 'Nueva subcarpeta'), icon: 'folderPlus', onClick: () => modalFolder(null, { parentId: node.id }) },
    '-',
    { label: tr('Rename', 'Renombrar'), icon: 'pen', disabled: isRoot, hint: 'F2', onClick: () => modalFolder(node) },
    { label: tr('Sort by name', 'Ordenar por nombre'), icon: 'sortAZ', disabled: (node.children || []).length < 2, onClick: () => sortFolderByName(node) },
    { label: tr('Move to…', 'Mover a…'), icon: 'folder', disabled: isRoot, onClick: () => modalMove([node.id]) },
    '-',
    { label: tr('Delete', 'Eliminar'), icon: 'trash', danger: true, disabled: isRoot, hint: tr('Del', 'Supr'), onClick: () => deleteNodes([node.id]) },
  ];
}

function multiMenuItems() {
  const ids = [...state.selection];
  const urls = ids.map((id) => nodeById.get(id)).filter((n) => n?.url).map((n) => n.url);
  return [
    { title: tr(`${ids.length} selected`, `${ids.length} seleccionados`) },
    { label: tr('Open all', 'Abrir todos'), icon: 'external', disabled: !urls.length, onClick: () => openAll(urls) },
    { label: tr('Open as tab group', 'Abrir como grupo de pestañas'), icon: 'layers', disabled: !urls.length, onClick: () => openAll(urls, { group: tr('Bookmarks', 'Marcadores') }) },
    { label: tr('Open in new window', 'Abrir en ventana nueva'), icon: 'window', disabled: !urls.length, onClick: () => openAll(urls, { newWindow: true }) },
    { label: tr('Move to…', 'Mover a…'), icon: 'folder', onClick: () => modalMove(ids) },
    { label: tr('Copy links', 'Copiar enlaces'), icon: 'copy', disabled: !urls.length, onClick: () => copyText(urls.join('\n'), tr(`${urls.length} links copied`, `${urls.length} enlaces copiados`)) },
    '-',
    { label: tr('Delete', 'Eliminar'), icon: 'trash', danger: true, onClick: () => deleteNodes(ids) },
    { label: tr('Deselect', 'Deseleccionar'), icon: 'x', hint: 'Esc', onClick: () => clearSelection() },
  ];
}

function itemMenuItems(node) {
  if (state.selection.size > 1 && state.selection.has(node.id)) return multiMenuItems();
  return node.url ? bookmarkMenuItems(node) : folderMenuItems(node);
}

function backgroundMenuItems() {
  const parentId = state.view.folderId;
  return [
    { label: tr('New bookmark', 'Nuevo marcador'), icon: 'plus', onClick: () => modalBookmark(null, { parentId }) },
    { label: tr('New folder', 'Nueva carpeta'), icon: 'folderPlus', onClick: () => modalFolder(null, { parentId }) },
    { label: tr('Paste link', 'Pegar enlace'), icon: 'link', hint: 'Ctrl+V', onClick: pasteFromClipboard },
    '-',
    { label: tr('Sort by name', 'Ordenar por nombre'), icon: 'sortAZ', onClick: () => sortFolderByName(nodeById.get(parentId)) },
    { label: tr('Select all', 'Seleccionar todo'), icon: 'check', hint: 'Ctrl+A', onClick: selectAll },
  ];
}

// ============ Modales ============
let currentModalClose = null;

function openModal({ title, submitLabel, danger = false, build, onSubmit, onClose }) {
  currentModalClose?.();
  const returnFocus = document.activeElement;
  const root = $('#modalRoot');
  root.hidden = false;
  root.innerHTML = '';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.hidden = true;
    root.innerHTML = '';
    currentModalClose = null;
    $('#app').inert = false;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    onClose?.();
  };
  const form = el('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modalTitle' });
  currentModalClose = () => { if (!form.dataset.busy) close(); };
  $('#app').inert = true;
  const body = el('div', { class: 'modal-body' });
  build(body, close);
  form.append(
    el('div', { class: 'modal-head' },
      el('h2', { id: 'modalTitle', text: title }),
      el('button', { type: 'button', class: 'icon-btn', html: svg('x', 16), title: tr('Close (Esc)', 'Cerrar (Esc)'), onClick: () => currentModalClose?.() })),
    body,
    el('div', { class: 'modal-foot' },
      el('button', { type: 'button', class: 'btn', text: tr('Cancel', 'Cancelar'), onClick: () => currentModalClose?.() }),
      submitLabel ? el('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}`, text: submitLabel }) : null),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = 'true';
    form.setAttribute('aria-busy', 'true');
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const ok = await onSubmit?.();
      if (ok !== false) close();
    } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); }
    finally { delete form.dataset.busy; form.removeAttribute('aria-busy'); if (submit) submit.disabled = false; }
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const inputs = [...form.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(n => n.getClientRects().length);
      const first = inputs[0], last = inputs.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); form.requestSubmit(); }
  });
  root.onmousedown = e => { if (e.target === root && !form.dataset.busy) close(); };
  root.append(form);
  for (const [index, field] of [...body.querySelectorAll('.field')].entries()) {
    const input = field.querySelector('input, select'), label = field.querySelector('label');
    if (input && label) { input.id ||= `modalField${index}`; label.htmlFor = input.id; }
  }
  (body.querySelector('input, select') || body.querySelector('button') || form.querySelector('button'))?.focus();
  return { close };
}

const modalOpen = () => currentModalClose != null;

function currentFolderId() {
  if (state.view.type === 'folder' && state.view.folderId) return state.view.folderId;
  return rootFolders[1]?.id ?? rootFolders[0]?.id;
}

function picker(value, opts = {}) {
  return folderPicker({ roots: rootFolders, value, recent: recentCache, ...opts });
}

function modalBookmark(node, { parentId, url: prefillUrl } = {}) {
  const isEdit = !!node;
  let nameI, urlI, folderS, urlField;
  openModal({
    title: isEdit ? tr('Edit bookmark', 'Editar marcador') : tr('New bookmark', 'Nuevo marcador'),
    submitLabel: isEdit ? tr('Save', 'Guardar') : tr('Add', 'Agregar'),
    build(body) {
      nameI = el('input', { type: 'text', value: node?.title ?? '', placeholder: prefillUrl ? domainOf(prefillUrl) : tr('Bookmark name', 'Nombre del marcador') });
      urlI = el('input', { type: 'text', value: node?.url ?? prefillUrl ?? '', placeholder: 'https://example.com', spellcheck: 'false' });
      urlI.addEventListener('input', () => urlField.classList.remove('invalid'));
      folderS = picker(isEdit ? node.parentId : (parentId ?? currentFolderId()), { onActivate: () => urlI.form?.requestSubmit() });
      urlField = el('div', { class: 'field' }, el('label', { text: 'URL' }), urlI, el('span', { class: 'err', text: tr('Enter a valid address', 'Ingresa una dirección válida') }));
      body.append(
        el('div', { class: 'field' }, el('label', { text: tr('Name', 'Nombre') }), nameI),
        urlField,
        el('div', { class: 'field' }, el('label', { text: tr('Folder', 'Carpeta') }), folderS.el),
      );
    },
    async onSubmit() {
      const url = normalizeUrl(urlI.value.trim());
      if (!url) { urlField.classList.add('invalid'); urlI.focus(); return false; }
      const title = nameI.value.trim() || domainOf(url);
      if (!folderS.value) { toast(tr('Choose a folder', 'Elige una carpeta'), { kind: 'info', icon: 'info' }); return false; }
      noteFolder(folderS.value);
      try {
        if (isEdit) {
          await bm.update(node.id, { title, url });
          if (folderS.value !== node.parentId) await bm.move(node.id, { parentId: folderS.value });
          toast(tr('Bookmark updated', 'Marcador actualizado'), { icon: 'check' });
        } else {
          await bm.create({ parentId: folderS.value, title, url });
          toast(tr('Bookmark added', 'Marcador agregado'), { icon: 'bookmark' });
        }
      } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); return false; }
    },
  });
}

function modalFolder(node, { parentId } = {}) {
  const isEdit = !!node;
  let nameI, parentS, nameField;
  openModal({
    title: isEdit ? tr('Rename folder', 'Renombrar carpeta') : tr('New folder', 'Nueva carpeta'),
    submitLabel: isEdit ? tr('Save', 'Guardar') : tr('Create', 'Crear'),
    build(body) {
      nameI = el('input', { type: 'text', value: node?.title ?? '', placeholder: tr('Folder name', 'Nombre de la carpeta') });
      nameI.addEventListener('input', () => nameField.classList.remove('invalid'));
      nameField = el('div', { class: 'field' }, el('label', { text: tr('Name', 'Nombre') }), nameI, el('span', { class: 'err', text: tr('Enter a name', 'Escribe un nombre') }));
      body.append(nameField);
      if (!isEdit) {
        parentS = picker(parentId ?? currentFolderId(), { onActivate: () => nameI.form?.requestSubmit() });
        body.append(el('div', { class: 'field' }, el('label', { text: tr('Inside', 'Dentro de') }), parentS.el));
      }
    },
    async onSubmit() {
      const title = nameI.value.trim();
      if (!title) { nameField.classList.add('invalid'); nameI.focus(); return false; }
      try {
        if (isEdit) { await bm.update(node.id, { title }); toast(tr('Folder renamed', 'Carpeta renombrada'), { icon: 'check' }); }
        else {
          if (!parentS.value) { toast(tr('Choose a folder', 'Elige una carpeta'), { kind: 'info', icon: 'info' }); return false; }
          const created = await bm.create({ parentId: parentS.value, title });
          state.expanded.add(parentS.value);
          savePref('mp-expanded', [...state.expanded]);
          toast(tr('Folder created', 'Carpeta creada'), { icon: 'folderPlus', actionLabel: tr('Open', 'Abrir'), onAction: () => setView({ type: 'folder', folderId: created.id }) });
        }
      } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); return false; }
    },
  });
}

function modalMove(ids) {
  const list = topLevelOnly(ids.filter((id) => nodeById.has(id)));
  if (!list.length) return;
  const excluded = new Set(list.filter((id) => !nodeById.get(id).url));
  const inExcluded = (id) => {
    if (excluded.has(id)) return true;
    for (const ex of excluded) if (isDescendant(id, ex)) return true;
    return false;
  };
  const single = list.length === 1 ? nodeById.get(list[0]) : null;
  let dest;

  openModal({
    title: tr(
      single ? `Move “${single.title || 'Untitled'}”` : `Move ${list.length} items`,
      single ? `Mover “${single.title || 'Sin nombre'}”` : `Mover ${list.length} elementos`,
    ),
    submitLabel: tr('Move here', 'Mover acá'),
    build(body) {
      dest = picker(null, { isDisabled: inExcluded, label: tr('Destination folder', 'Carpeta de destino'), onActivate: () => dest.input.form?.requestSubmit() });
      body.append(el('p', { class: 'msg', text: tr('Choose the destination folder — type to filter:', 'Elige la carpeta de destino; escribe para filtrar:') }), dest.el);
    },
    async onSubmit() {
      if (!dest.value) { toast(tr('Choose a destination folder', 'Elige una carpeta de destino'), { kind: 'info', icon: 'info' }); return false; }
      return await moveNodesTo(list, dest.value, null);
    },
  });
}

// Guarda las pestañas de una ventana en una carpeta nueva. El permiso «tabs» es opcional:
// se pide solo al usarlo, porque Chrome lo describe como acceso al historial.
async function modalSaveTabs(windowParam = 'current') {
  let granted = !IS_EXT || await chrome.permissions.contains({ permissions: ['tabs'] }).catch(() => false);
  let tabs = [];
  let body, nameI, dest, listBox, skipI;

  const loadTabs = async () => {
    if (!IS_EXT) {
      return [
        { title: 'MDN — Array.prototype.map()', url: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/map' },
        { title: 'Chrome Extensions — Manifest V3', url: 'https://developer.chrome.com/docs/extensions/mv3/intro/' },
        { title: 'GitHub', url: 'https://github.com/' },
        { title: 'Figma', url: 'https://www.figma.com/' },
      ];
    }
    const query = /^\d+$/.test(windowParam) ? { windowId: Number(windowParam) } : { currentWindow: true };
    let found = await chrome.tabs.query(query).catch(() => []);
    if (!found.length && query.windowId) found = await chrome.tabs.query({ currentWindow: true });
    const self = (await chrome.tabs.getCurrent().catch(() => null))?.id;
    return found
      .filter(t => t.id !== self && t.url && !/^chrome:\/\/newtab/.test(t.url) && normalizeUrl(t.url, { addScheme: false }))
      .map(t => ({ title: t.title || t.url, url: t.url }));
  };

  const renderBody = () => {
    body.replaceChildren();
    const submit = $('#modalRoot [type="submit"]');
    if (!granted) {
      body.append(el('div', { class: 'import-summary' },
        el('span', { class: 'icn', html: svg('layers', 24) }),
        el('div', {}, el('strong', { text: tr('Allow reading your open tabs', 'Permite leer tus pestañas abiertas') }),
          el('p', { text: tr('Chrome will ask once for permission to see the titles and addresses of your tabs. Mark My Tabs only reads them when you use this action.', 'Chrome te pedirá permiso una sola vez para ver los títulos y direcciones de tus pestañas. Mark My Tabs solo los lee cuando usas esta acción.') }))));
      if (submit) submit.textContent = tr('Allow and continue', 'Permitir y continuar');
      return;
    }
    if (!tabs.length) {
      body.append(el('p', { class: 'msg', text: tr('There are no tabs that can be saved in this window.', 'No hay pestañas que se puedan guardar en esta ventana.') }));
      if (submit) submit.disabled = true;
      return;
    }
    nameI = el('input', { type: 'text', id: 'saveTabsName', maxlength: '200', value: `${tr('Tabs', 'Pestañas')} · ${new Date().toLocaleString(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` });
    dest = picker(currentFolderId());
    skipI = el('input', { type: 'checkbox' });
    listBox = el('div', { class: 'tab-list' });
    const updateCount = () => {
      const n = $$('input[type="checkbox"]:checked', listBox).length;
      if (submit) { submit.textContent = tr(`Save ${n} ${n === 1 ? 'tab' : 'tabs'}`, `Guardar ${n} ${n === 1 ? 'pestaña' : 'pestañas'}`); submit.disabled = !n; }
    };
    tabs.forEach((t, i) => {
      const check = el('input', { type: 'checkbox', checked: true, dataset: { i: String(i) }, onChange: updateCount });
      listBox.append(el('label', { class: 'tab-row', title: t.url }, check, faviconEl(t.url, 16),
        el('span', { class: 'tab-title', text: t.title }), el('span', { class: 'tab-domain', text: domainOf(t.url) })));
    });
    const toggleAll = el('button', { type: 'button', class: 'btn ghost sm', text: tr('Select none', 'Ninguna'), onClick: () => {
      const all = $$('input[type="checkbox"]', listBox);
      const on = !all.every(c => c.checked);
      all.forEach(c => { c.checked = on; });
      toggleAll.textContent = on ? tr('Select none', 'Ninguna') : tr('Select all', 'Todas');
      updateCount();
    } });
    body.append(
      el('div', { class: 'field' }, el('label', { text: tr('New folder name', 'Nombre de la nueva carpeta'), for: 'saveTabsName' }), nameI),
      el('div', { class: 'field' }, el('label', { text: tr('Inside', 'Dentro de') }), dest.el),
      el('div', { class: 'tab-list-head' }, el('span', { text: tr(`${tabs.length} open ${tabs.length === 1 ? 'tab' : 'tabs'}`, `${tabs.length} ${tabs.length === 1 ? 'pestaña abierta' : 'pestañas abiertas'}`) }), toggleAll),
      listBox,
      el('label', { class: 'check-line' }, skipI, tr('Skip pages already saved', 'Omitir páginas ya guardadas')),
    );
    updateCount();
    nameI.focus(); nameI.select();
  };

  openModal({
    title: tr('Save open tabs', 'Guardar pestañas abiertas'),
    submitLabel: tr('Save', 'Guardar'),
    build(b) { body = b; },
    async onSubmit() {
      if (!granted) {
        // Primera llamada del gesto: Chrome exige que el pedido de permiso venga de un clic.
        granted = await chrome.permissions.request({ permissions: ['tabs'] }).catch(() => false);
        if (granted) { tabs = await loadTabs(); renderBody(); }
        else toast(tr('Permission was not granted', 'No se concedió el permiso'), { kind: 'info', icon: 'info' });
        return false;
      }
      if (!tabs.length) return false;
      const chosen = $$('input[type="checkbox"]:checked', listBox).map(c => tabs[Number(c.dataset.i)]);
      const known = new Set(skipI.checked ? allBookmarks.map(n => urlKey(n.url)) : []);
      const toSave = chosen.filter(t => !known.has(urlKey(t.url)));
      if (!toSave.length) { toast(tr('All those pages are already saved', 'Todas esas páginas ya están guardadas'), { kind: 'info', icon: 'info' }); return false; }
      if (!dest.value) { toast(tr('Choose a folder', 'Elige una carpeta'), { kind: 'info', icon: 'info' }); return false; }
      noteFolder(dest.value);
      let created;
      try {
        created = await bm.create({ parentId: dest.value, title: nameI.value.trim() || tr('Tabs', 'Pestañas') });
        for (const t of toSave) await bm.create({ parentId: created.id, title: t.title, url: t.url });
      } catch (err) {
        if (created) await bm.removeTree(created.id).catch(() => {});
        throw err;
      }
      await refresh();
      setView({ type: 'folder', folderId: created.id });
      toast(tr(`${toSave.length} ${toSave.length === 1 ? 'tab saved' : 'tabs saved'}`, `${toSave.length} ${toSave.length === 1 ? 'pestaña guardada' : 'pestañas guardadas'}`), {
        icon: 'layers', undo: () => bm.removeTree(created.id),
      });
    },
  });
  if (granted) tabs = await loadTabs();
  renderBody();
}

async function pasteFromClipboard() {
  try { handlePastedText(await navigator.clipboard.readText()); }
  catch { toast(tr('Press Ctrl+V to paste a link here', 'Pulsa Ctrl+V para pegar un enlace aquí'), { kind: 'info', icon: 'info' }); }
}

function handlePastedText(text) {
  const urls = urlsFromText(text);
  if (!urls.length) { toast(tr('The clipboard has no links', 'El portapapeles no tiene enlaces'), { kind: 'info', icon: 'info' }); return false; }
  const parentId = currentFolderId();
  if (urls.length === 1) modalBookmark(null, { parentId, url: urls[0] });
  else addUrls(urls.map(url => ({ url })), parentId);
  return true;
}

function modalConfirm({ title, msg, confirmLabel = tr('Delete', 'Eliminar'), danger = true }) {
  return new Promise((resolve) => {
    openModal({
      title, submitLabel: confirmLabel, danger,
      build(body) { if (msg) body.append(el('p', { class: 'msg', text: msg })); },
      onSubmit() { resolve(true); },
      onClose() { resolve(false); },
    });
  });
}

// ============ Toasts ============
function toast(msg, { icon: ic = 'check', kind = 'ok', actionLabel, onAction, duration, undo } = {}) {
  const wrap = $('#toasts');
  const t = el('div', { class: 'toast' },
    el('span', { class: `icn ${kind}`, html: svg(ic, 17) }),
    el('span', { class: 'msg', text: msg }));
  const dismiss = () => {
    if (lastUndo?.toast === t) lastUndo = null;
    t.classList.add('out');
    setTimeout(() => t.remove(), 160);
  };
  if (undo) {
    actionLabel = tr('Undo', 'Deshacer');
    onAction = async () => {
      try { await undo(); toast(tr('Undone', 'Deshecho'), { icon: 'undo' }); }
      catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); }
    };
    lastUndo = { toast: t, run: () => { onAction(); dismiss(); } };
  }
  if (actionLabel) {
    const a = el('button', { class: 'action', text: actionLabel });
    a.addEventListener('click', () => { onAction?.(); dismiss(); });
    t.append(a);
  }
  wrap.append(t);
  while (wrap.children.length > 4) wrap.firstChild.remove();
  setTimeout(dismiss, duration ?? (undo ? 9000 : actionLabel ? 7000 : 3200));
}

// ============ Eventos de contenido ============
content.addEventListener('click', (e) => {
  const item = e.target.closest('[data-id]');
  if (!item) {
    if (state.selection.size && !e.target.closest('button')) clearSelection();
    return;
  }
  const node = nodeById.get(item.dataset.id);
  if (!node) return;
  const menuBtn = e.target.closest('.card-menu, .row-menu');
  if (menuBtn) {
    const r = menuBtn.getBoundingClientRect();
    showMenu(r.right - 210, r.bottom + 4, itemMenuItems(node));
    return;
  }
  if (e.target.closest('.sel-check')) { toggleSelect(node.id); return; }
  if (e.shiftKey) { rangeSelect(node.id); return; }
  if (e.ctrlKey || e.metaKey) { toggleSelect(node.id); return; }
  if (state.selection.size) { toggleSelect(node.id); return; }
  openItem(node);
});

content.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const item = e.target.closest('[data-id]');
  if (!item) return;
  const node = nodeById.get(item.dataset.id);
  if (node?.url) { e.preventDefault(); openUrl(node.url, { active: false }); }
});

content.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const item = e.target.closest('[data-id]');
  if (item) {
    const node = nodeById.get(item.dataset.id);
    if (node) showMenu(e.clientX, e.clientY, itemMenuItems(node));
  } else if (!searching() && state.view.type === 'folder') {
    showMenu(e.clientX, e.clientY, backgroundMenuItems());
  }
});

content.addEventListener('keydown', (e) => {
  const item = e.target.closest?.('[data-id]');
  if (!item) return;
  const node = nodeById.get(item.dataset.id);
  if (!node) return;
  if (e.key === 'Enter') { e.preventDefault(); openItem(node); }
  else if (e.key === ' ') { e.preventDefault(); toggleSelect(node.id); }
});

content.addEventListener('scroll', hideMenu, { passive: true });

// ============ Teclado global ============
function focusSearch() {
  searchInput.focus();
  searchInput.select();
}

function moveFocus(delta) {
  const els = itemEls();
  if (!els.length) return;
  const cur = els.indexOf(document.activeElement);
  let next = cur === -1 ? 0 : cur + delta;
  next = Math.max(0, Math.min(els.length - 1, next));
  els[next].focus();
  els[next].scrollIntoView({ block: 'nearest' });
}

function gridColumns() {
  if (state.layout !== 'grid') return 1;
  const els = itemEls();
  if (els.length < 2) return 1;
  const top = els[0].offsetTop;
  let c = 1;
  while (c < els.length && els[c].offsetTop === top) c++;
  return c;
}

document.addEventListener('keydown', (e) => {
  if (!modalOpen() && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return; }
  if (e.key === 'Escape') {
    if (menuOpen) { hideMenu(); return; }
    if (modalOpen()) { currentModalClose(); return; }
    if (document.activeElement === searchInput && searchInput.value) { setQuery(''); return; }
    if (state.selection.size) { clearSelection(); return; }
    if (searching()) { setQuery(''); return; }
    return;
  }
  if (modalOpen()) return;
  if (menuOpen) return;
  const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (inInput) {
    if (e.target === searchInput && e.key === 'Enter' && state.items.length) {
      openItem(state.items[0]);
    }
    if (e.target === searchInput && e.key === 'ArrowDown' && state.items.length) {
      e.preventDefault();
      itemEls()[0]?.focus();
    }
    return;
  }
  if (e.key === '/') { e.preventDefault(); focusSearch(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (lastUndo) lastUndo.run();
    else toast(tr('Nothing to undo', 'No hay nada para deshacer'), { kind: 'info', icon: 'info' });
    return;
  }
  if (e.key === 'Delete') {
    const focused = document.activeElement?.closest?.('[data-id]');
    const ids = state.selection.size ? [...state.selection] : (focused ? [focused.dataset.id] : []);
    if (ids.length) deleteNodes(ids);
    return;
  }
  if (e.key === 'F2') {
    const focused = document.activeElement?.closest?.('[data-id]');
    const id = state.selection.size === 1 ? [...state.selection][0] : focused?.dataset.id;
    const n = id && nodeById.get(id);
    if (n) { n.url ? modalBookmark(n) : modalFolder(n); }
    return;
  }
  if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    if (!itemEls().length) return;
    e.preventDefault();
    const cols = gridColumns();
    moveFocus(e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : -cols);
  }
});

document.addEventListener('paste', (e) => {
  if (modalOpen() || menuOpen || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const text = e.clipboardData?.getData('text') || '';
  if (!urlsFromText(text).length) return;
  e.preventDefault();
  handlePastedText(text);
});

// cierre del menú contextual
document.addEventListener('click', (e) => {
  if (menuOpen && !e.target.closest('#ctxMenu')) { e.preventDefault(); e.stopPropagation(); hideMenu(); }
}, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('resize', hideMenu);

// ============ Topbar ============
function saveBackup(kind, onlyFolder = false) {
  const folder = onlyFolder && nodeById.get(state.view.folderId);
  const nodes = folder ? [folder] : rootFolders;
  const json = kind === 'json';
  downloadFile(`mark-my-tabs-${new Date().toISOString().slice(0, 10)}.${kind}`,
    json ? exportJson(nodes) : exportHtml(nodes), json ? 'application/json' : 'text/html;charset=utf-8');
  toast(tr('Backup exported', 'Respaldo exportado'), { icon: 'download' });
}

$('#btnBackup').addEventListener('click', () => {
  const r = $('#btnBackup').getBoundingClientRect();
  showMenu(r.right + 8, r.top, [
    { title: tr('Your bookmarks, with you', 'Tus marcadores, contigo') },
    { label: tr('Export all · JSON backup', 'Exportar todo · Respaldo JSON'), icon: 'download', onClick: () => saveBackup('json') },
    { label: tr('Export all · Browser HTML', 'Exportar todo · HTML para navegadores'), icon: 'download', onClick: () => saveBackup('html') },
    ...(state.view.type === 'folder' ? [{ label: tr('Export this folder · HTML', 'Exportar esta carpeta · HTML'), icon: 'folder', onClick: () => saveBackup('html', true) }] : []),
    '-',
    { label: tr('Import JSON or HTML…', 'Importar JSON o HTML…'), icon: 'upload', onClick: () => $('#importFile').click() },
  ]);
});

$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error(tr('Choose a file smaller than 10 MB.', 'Elige un archivo de menos de 10 MB.'));
    const parsed = parseBackup(await file.text(), /\.html?$/i.test(file.name));
    let destination, name, skip;
    openModal({
      title: tr('Import bookmarks', 'Importar marcadores'), submitLabel: tr('Import', 'Importar'),
      build(body) {
        body.append(el('div', { class: 'import-summary' },
          el('span', { class: 'icn', html: svg('upload', 24) }),
          el('div', {}, el('strong', { text: file.name }), el('p', { text: `${fmtNum(parsed.bookmarks)} ${parsed.bookmarks === 1 ? tr('bookmark', 'marcador') : tr('bookmarks', 'marcadores')} · ${fmtNum(parsed.folders)} ${parsed.folders === 1 ? tr('folder', 'carpeta') : tr('folders', 'carpetas')}` }))));
        name = el('input', { type: 'text', value: tr('Imported', 'Importados') + ' · ' + new Date().toLocaleDateString(getLocale()), required: true, maxlength: '200' });
        destination = picker(currentFolderId());
        skip = el('input', { type: 'checkbox', checked: true });
        body.append(
          el('p', { class: 'msg', text: tr('A new folder will keep the imported collection together. Your existing bookmarks stay in place.', 'Una carpeta nueva reunirá la colección importada. Tus marcadores actuales se conservan.') }),
          el('div', { class: 'field' }, el('label', { text: tr('New folder name', 'Nombre de la nueva carpeta') }), name),
          el('div', { class: 'field' }, el('label', { text: tr('Destination', 'Destino') }), destination.el),
          el('label', { class: 'check-line' }, skip, tr('Skip URLs already saved', 'Omitir URLs ya guardadas')),
        );
      },
      async onSubmit() {
        const known = new Set(skip.checked ? allBookmarks.map(n => urlKey(n.url)) : []);
        let saved = 0, skipped = 0, created;
        if (!destination.value) { toast(tr('Choose a folder', 'Elige una carpeta'), { kind: 'info', icon: 'info' }); return false; }
        noteFolder(destination.value);
        try {
          created = await bm.create({ parentId: destination.value, title: name.value.trim() || tr('Imported', 'Importados') });
          const add = async (nodes, parentId) => {
            for (const n of nodes) {
              if (n.url) {
                const key = urlKey(n.url);
                if (skip.checked && known.has(key)) { skipped++; continue; }
                await bm.create({ parentId, title: n.title, url: n.url });
                known.add(key); saved++;
              } else {
                const folder = await bm.create({ parentId, title: n.title });
                await add(n.children, folder.id);
              }
            }
          };
          await add(parsed.children, created.id);
        } catch (err) {
          if (created) {
            try { await bm.removeTree(created.id); }
            catch { throw new Error(tr('Import stopped. Some items remain in the import folder; review it before retrying.', 'La importación se detuvo. Quedan elementos en la carpeta importada; revísala antes de reintentar.')); }
          }
          throw err;
        }
        await refresh();
        setView({ type: 'folder', folderId: created.id });
        toast(tr(`${fmtNum(saved)} ${saved === 1 ? 'bookmark imported' : 'bookmarks imported'} · ${fmtNum(skipped)} skipped`, `${fmtNum(saved)} ${saved === 1 ? 'marcador importado' : 'marcadores importados'} · ${fmtNum(skipped)} ${skipped === 1 ? 'omitido' : 'omitidos'}`), {
          icon: 'upload', duration: 12000, undo: () => bm.removeTree(created.id),
        });
      },
    });
  } catch (err) { toast(errMsg(err), { kind: 'err', icon: 'alert' }); }
});

$('#btnHelp').addEventListener('click', () => openModal({
  title: tr('Make yourself at home', 'Muévete como en casa'),
  build(body) {
    const section = (title) => body.append(el('h3', { class: 'help-title', text: title }));
    const rows = (list) => { for (const [keys, label] of list) body.append(el('div', { class: 'shortcut-row' }, el('kbd', { text: keys }), el('span', { text: label }))); };
    section(tr('Keyboard', 'Teclado'));
    rows([
      ['Ctrl / ⌘ + K', tr('Search everything, including folder paths', 'Buscar en todo, incluidas rutas de carpetas')],
      ['Alt + B', tr('Open the manager', 'Abrir el administrador')],
      ['Alt + M', tr('Save or edit the current page', 'Guardar o editar la página actual')],
      ['↑ ↓ ← →', tr('Navigate bookmarks and folders', 'Navegar por marcadores y carpetas')],
      ['Ctrl / ⌘ + A', tr('Select all visible items', 'Seleccionar todos los elementos visibles')],
      ['F2 / Delete', tr('Edit / delete', 'Editar / eliminar')],
      ['Ctrl / ⌘ + Z', tr('Undo the last change', 'Deshacer el último cambio')],
      ['Ctrl / ⌘ + V', tr('Paste links into the current folder', 'Pegar enlaces en la carpeta actual')],
      ['Esc', tr('Close or clear the current action', 'Cerrar o limpiar la acción actual')],
    ]);
    section(tr('Search like a pro', 'Busca como un experto'));
    rows([
      ['site:github.com', tr('Only bookmarks from that site', 'Solo marcadores de ese sitio')],
      ['in:dev', tr('Inside folders whose path contains “dev”', 'Dentro de carpetas cuya ruta contiene «dev»')],
      ['is:folder', tr('Only folders (or is:bookmark)', 'Solo carpetas (o is:bookmark)')],
      [tr('-word', '-palabra'), tr('Exclude results with that word', 'Excluir resultados con esa palabra')],
      [tr('"exact phrase"', '"frase exacta"'), tr('Match the words together', 'Buscar las palabras juntas')],
      ['mt + Space', tr('Search from Chrome’s address bar', 'Buscar desde la barra de direcciones de Chrome')],
    ]);
    body.append(el('p', { class: 'msg', text: tr('Drag links from any page onto a folder to save them, right-click a page to save it, and use Cleanup to remove duplicates, empty folders and broken links.', 'Arrastra enlaces desde cualquier página hasta una carpeta para guardarlos, haz clic derecho en una página para guardarla y usa Limpieza para quitar duplicados, carpetas vacías y enlaces rotos.') }));
  },
}));

function applyLayoutBtn() {
  $('#btnLayout').innerHTML = svg(state.layout === 'grid' ? 'list' : 'grid', 17);
  $('#btnLayout').title = state.layout === 'grid' ? tr('View as list', 'Ver como lista') : tr('View as grid', 'Ver como cuadrícula');
}
function applyThemeBtn() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#btnTheme').innerHTML = svg(dark ? 'sun' : 'moon', 17);
  $('#btnTheme').title = dark ? tr('Light theme', 'Tema claro') : tr('Dark theme', 'Tema oscuro');
}
function applySortBtn() {
  const options = sorts();
  const cur = options.find((s) => s.id === state.sort) || options[0];
  const b = $('#btnSort');
  b.innerHTML = `${svg('sort', 15)}<span>${cur.label}</span>${svg('chevron', 12)}`;
  b.querySelector('svg:last-child').style.transform = 'rotate(90deg)';
}

$('#btnLayout').addEventListener('click', () => {
  state.layout = state.layout === 'grid' ? 'list' : 'grid';
  savePref('mp-layout', state.layout);
  applyLayoutBtn();
  renderContent();
});

$('#btnTheme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mp-theme', next); } catch { /* */ }
  applyThemeBtn();
});

$('#btnSort').addEventListener('click', () => {
  const r = $('#btnSort').getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, sorts().map((s) => ({
    label: s.label,
    icon: s.id === state.sort ? 'check' : 'sort',
    checked: false,
    onClick: () => {
      state.sort = s.id;
      savePref('mp-sort', s.id);
      applySortBtn();
      renderContent();
    },
  })));
});

$('#btnAdd').addEventListener('click', () => {
  const r = $('#btnAdd').getBoundingClientRect();
  showMenu(r.right - 210, r.bottom + 6, [
    { label: tr('New bookmark', 'Nuevo marcador'), icon: 'plus', onClick: () => modalBookmark(null, {}) },
    { label: tr('New folder', 'Nueva carpeta'), icon: 'folderPlus', onClick: () => modalFolder(null, {}) },
    '-',
    { label: tr('Save open tabs…', 'Guardar pestañas abiertas…'), icon: 'layers', onClick: () => modalSaveTabs() },
    { label: tr('Paste link', 'Pegar enlace'), icon: 'link', hint: 'Ctrl+V', onClick: pasteFromClipboard },
  ]);
});

$('#btnTreeNewFolder').addEventListener('click', () => modalFolder(null, {}));

searchInput.addEventListener('input', debounce(() => setQuery(searchInput.value, { fromInput: true }), 120));
$('#btnClearSearch').addEventListener('click', () => { setQuery(''); searchInput.focus(); });

// sidebar móvil
function closeSidebarMobile() {
  $('#app').classList.remove('sidebar-open');
  $('#sidebarBackdrop').hidden = true;
}
$('#btnSidebar').addEventListener('click', () => {
  const open = $('#app').classList.toggle('sidebar-open');
  $('#sidebarBackdrop').hidden = !open;
});
$('#sidebarBackdrop').addEventListener('click', closeSidebarMobile);

// tip de bienvenida
function renderTip() {
  if (state.tipDismissed) return;
  const tip = $('#tipbar');
  tip.hidden = false;
  tip.append(
    el('span', { class: 'icn', html: svg('sparkles', 16) }),
    el('span', {
      html: tr(
        'Tip: press <kbd>Ctrl</kbd> <kbd>K</kbd> to search instantly, drag to organize, and right-click for every action.',
        'Consejo: <kbd>Ctrl</kbd> <kbd>K</kbd> para buscar al instante, arrastra para organizar y clic derecho para ver todas las opciones.',
      ),
    }),
    el('button', { class: 'icon-btn', html: svg('x', 14), title: tr('Close', 'Cerrar'), onClick: () => { tip.hidden = true; state.tipDismissed = true; savePref('mp-tip-dismissed', true); } }),
  );
}

// ============ Init ============
async function init() {
  applyI18n();
  $('#btnSidebar').innerHTML = svg('menu', 18);
  $('#btnTreeNewFolder').innerHTML = svg('plus', 14);
  $('#btnClearSearch').innerHTML = svg('x', 14);
  $('#searchWrap .search-icn').innerHTML = svg('search', 16);
  $('#btnAdd').innerHTML = `${svg('plus', 16)}<span>${tr('Add', 'Agregar')}</span>`;
  $('#btnBackup').innerHTML = `<span class="icn">${svg('download', 17)}</span><span>${tr('Backups & import', 'Respaldos e importación')}</span>`;
  $('#btnHelp').innerHTML = `<span class="icn">${svg('info', 17)}</span><span>${tr('Shortcuts & help', 'Atajos y ayuda')}</span>`;
  searchInput.setAttribute('aria-label', tr('Search your bookmarks', 'Buscar en tus marcadores'));
  const langBtn = $('#btnLang');
  langBtn.textContent = languageButtonText();
  langBtn.title = languageButtonTitle();
  langBtn.addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'es' : 'en');
    location.reload();
  });
  applyLayoutBtn();
  applyThemeBtn();
  applySortBtn();
  renderTip();

  const params = new URLSearchParams(location.search);
  if (params.get('folder')) state.view = { type: 'folder', folderId: params.get('folder') };
  const q = params.get('q');
  const saveTabs = params.get('saveTabs');
  if (saveTabs) history.replaceState(null, '', location.pathname);

  [recentCache, linkReport] = await Promise.all([recentFolders(), loadLinkReport()]);
  await refresh();

  if (state.expanded.size === 0) {
    for (const f of rootFolders) state.expanded.add(f.id);
    savePref('mp-expanded', [...state.expanded]);
    renderTree();
  }
  if (q) { searchInput.value = q; setQuery(q); }
  if (saveTabs) modalSaveTabs(saveTabs);

  bm.onAny(debounce(refresh, 250));

  if (IS_EXT && chrome.runtime?.sendMessage) {
    try { chrome.runtime.sendMessage({ type: 'manager-ready' }).catch(() => {}); } catch { /* */ }
  }
}

init().catch(err => toast(errMsg(err), { kind: 'err', icon: 'alert', duration: 10000 }));
