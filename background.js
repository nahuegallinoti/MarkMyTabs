import { parseQuery, queryScore, escapeHtml, domainOf } from './common/search.js';

const MANAGER_URL = chrome.runtime.getURL('manager/manager.html');
const i18n = (key, fallback) => chrome.i18n.getMessage(key) || fallback;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openManager().catch(() => {});
  createMenus();
});

// ---------- Menú contextual ----------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-page', title: i18n('menuSavePage', 'Save page to Mark My Tabs…'), contexts: ['page'] });
    chrome.contextMenus.create({ id: 'save-link', title: i18n('menuSaveLink', 'Save link to Mark My Tabs…'), contexts: ['link'] });
    chrome.contextMenus.create({ id: 'save-tabs', title: i18n('menuSaveTabs', 'Save all tabs to a folder…'), contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'open-manager', title: i18n('openManagerCommand', 'Open the bookmark manager'), contexts: ['action'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-page') {
    openSaveDialog({ url: info.pageUrl || tab?.url, title: tab?.title, tabId: tab?.id }).catch(() => {});
  } else if (info.menuItemId === 'save-link' && info.linkUrl) {
    openSaveDialog({ url: info.linkUrl, title: info.linkText || info.selectionText || '', tabId: tab?.id }).catch(() => {});
  } else if (info.menuItemId === 'save-tabs') {
    openManager(`?saveTabs=${tab?.windowId ?? 'current'}`).catch(() => {});
  } else if (info.menuItemId === 'open-manager') {
    openManager().catch(() => {});
  }
});

// ---------- Omnibox: «mt» + espacio en la barra de direcciones ----------
chrome.omnibox.setDefaultSuggestion({ description: i18n('omniboxDefault', 'Search Mark My Tabs bookmarks') });

async function searchBookmarks(text, limit = 8) {
  const parsed = parseQuery(text);
  if (parsed.empty) return [];
  const [root] = await chrome.bookmarks.getTree();
  const results = [];
  (function walk(node, path) {
    for (const c of node.children || []) {
      if (c.url) {
        const score = queryScore(c, parsed, path.join(' / '));
        if (score >= 0) results.push([score, c, path]);
      } else walk(c, [...path, c.title]);
    }
  })(root, []);
  results.sort((a, b) => b[0] - a[0] || (b[1].dateAdded || 0) - (a[1].dateAdded || 0));
  return results.slice(0, limit);
}

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  try {
    const results = await searchBookmarks(text);
    suggest(results.map(([, node, path]) => ({
      content: node.url,
      description: `${escapeHtml(node.title || domainOf(node.url))} <dim>${escapeHtml(path.join(' / '))}</dim> <url>${escapeHtml(node.url)}</url>`,
    })));
  } catch { suggest([]); }
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  let url = /^(https?|ftp|file):/i.test(text) ? text : null;
  if (!url) {
    // Enter sin elegir sugerencia: abre el mejor resultado o, si no hay, la búsqueda en el administrador.
    const [best] = await searchBookmarks(text, 1).catch(() => []);
    if (!best) { openManager(`?q=${encodeURIComponent(text.slice(0, 2000))}`).catch(() => {}); return; }
    url = best[1].url;
  }
  if (disposition === 'currentTab') chrome.tabs.update({ url }).catch(() => chrome.tabs.create({ url }));
  else chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});

// ---------- Administrador ----------
// Reutiliza la pestaña del administrador si ya está abierta, si no crea una nueva
async function openManager(params = '') {
  const destination = MANAGER_URL + params;
  try {
    const { managerTabId } = await chrome.storage.session.get('managerTabId');
    // getContexts only sees our own pages and needs no access to browsing history.
    // tabs.get().url is not available with this extension's limited permissions.
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const managers = contexts.filter(c => c.documentUrl?.split('?')[0].split('#')[0] === MANAGER_URL && c.tabId >= 0);
    const existing = managers.find(c => c.tabId === managerTabId) || managers[0];
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true, ...(params ? { url: destination } : {}) });
      await chrome.windows.update(existing.windowId, { focused: true });
      await chrome.storage.session.set({ managerTabId: existing.tabId });
      return;
    }
  } catch (e) { /* la pestaña ya no existe */ }
  const tab = await chrome.tabs.create({ url: destination });
  await chrome.storage.session.set({ managerTabId: tab.id });
}

// Abre el diálogo de guardar/editar marcador (por defecto, para la pestaña actual),
// centrado sobre la ventana del navegador. Si ya había uno abierto, lo reemplaza.
async function openSaveDialog(target) {
  if (!target?.url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    target = { url: tab?.url, title: tab?.title, tabId: tab?.id };
  }
  if (!target.url) return;
  const { saveWinId } = await chrome.storage.session.get('saveWinId');
  if (saveWinId != null) {
    try { await chrome.windows.remove(saveWinId); } catch (e) { /* ya cerrada */ }
  }
  const params = new URLSearchParams({ url: target.url, title: target.title || '', tabId: String(target.tabId ?? '') });
  const cur = await chrome.windows.getCurrent();
  const width = 480, height = 600;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('save/save.html') + '?' + params.toString(),
    type: 'popup',
    width, height,
    left: Math.max(0, Math.round((cur.left ?? 0) + ((cur.width ?? width) - width) / 2)),
    top: Math.max(0, Math.round((cur.top ?? 0) + ((cur.height ?? height) - height) / 3)),
  });
  chrome.storage.session.set({ saveWinId: win.id });
}

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  chrome.action.setBadgeTextColor({ color: '#ffffff', tabId }).catch(() => {});
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 1800);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-manager') openManager().catch(() => {});
  if (command === 'save-current') openSaveDialog().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'manager-ready' && sender.tab) {
    chrome.storage.session.set({ managerTabId: sender.tab.id });
  }
  if (msg?.type === 'open-manager') {
    const input = new URLSearchParams(typeof msg.params === 'string' ? msg.params : '');
    const safe = new URLSearchParams();
    for (const key of ['q', 'folder']) if (input.has(key)) safe.set(key, input.get(key).slice(0, 2000));
    if (/^(\d{1,12}|current)$/.test(input.get('saveTabs') || '')) safe.set('saveTabs', input.get('saveTabs'));
    openManager(safe.size ? '?' + safe : '').catch(() => {});
  }
  if (msg?.type === 'flash-badge' && msg.tabId != null) {
    if (msg.kind === 'saved') flashBadge(msg.tabId, '✓', '#22c55e');
    if (msg.kind === 'removed') flashBadge(msg.tabId, '✕', '#6b7280');
  }
});
