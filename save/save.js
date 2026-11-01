import {
  $, svg, faviconEl, domainOf, bm, IS_EXT, lastSaveFolder, rememberSaveFolder, recentFolders,
  normalizeUrl, bookmarkUrlKey, timeAgo,
} from '../common/utils.js';
import { folderPicker } from '../common/folder-picker.js';
import { applyI18n, getLang, languageButtonText, languageButtonTitle, setLang, tr } from '../common/i18n.js';

const params = new URLSearchParams(location.search);
const pageUrl = params.get('url') || 'https://example.dev/article';
const pageTitle = params.get('title') || '';
const tabId = Number(params.get('tabId')) || null;

const nameI = $('#name');

let existing = null;
let nodeById = new Map();
let picker = null;
let busy = false;

function showError(err) {
  $('#error').hidden = false;
  $('#error').textContent = tr('Could not complete the action. ', 'No se pudo completar la acción. ') + (err?.message || tr('Please try again.', 'Vuelve a intentarlo.'));
}

async function perform(action) {
  if (busy) return;
  busy = true; $('#error').hidden = true;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach(b => { b.disabled = true; });
  try { await action(); }
  catch (err) { showError(err); }
  finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
}

function indexTree(root) {
  nodeById = new Map();
  let found = null;
  const key = bookmarkUrlKey(pageUrl);
  (function walk(n) {
    nodeById.set(n.id, n);
    if (n.url && !found && bookmarkUrlKey(n.url) === key) found = n;
    for (const c of n.children || []) walk(c);
  })(root);
  return found;
}

function pathLabel(id) {
  const parts = [];
  for (let n = nodeById.get(id); n?.parentId; n = nodeById.get(n.parentId)) parts.unshift(n.title || tr('Untitled', 'Sin nombre'));
  return parts.join(' / ');
}

function syncNewFolderHint() {
  $('#newFolderName').placeholder = tr(`New folder inside “${nodeById.get(picker.value)?.title || ''}”`, `Nueva carpeta dentro de «${nodeById.get(picker.value)?.title || ''}»`);
}

function notifyBadge(kind) {
  if (!IS_EXT || tabId == null || !chrome.runtime?.sendMessage) return;
  try { chrome.runtime.sendMessage({ type: 'flash-badge', tabId, kind }).catch(() => {}); } catch { /* */ }
}

function done() {
  window.close();
}

async function init() {
  applyI18n();
  $('#btnNewFolder').innerHTML = `${svg('folderPlus', 14)}<span>${tr('New folder', 'Nueva carpeta')}</span>`;
  $('#pageFav').append(faviconEl(pageUrl, 20));
  $('#pageUrl').textContent = pageUrl;
  $('#pageUrl').title = pageUrl;

  const [root] = await bm.getTree();
  existing = indexTree(root);

  let selected;
  if (existing) {
    document.title = tr('Edit bookmark', 'Editar marcador');
    $('#dlgTitle').textContent = tr('Edit bookmark', 'Editar marcador');
    $('#btnRemove').hidden = false;
    $('#savedInfo').hidden = false;
    $('#savedInfo').innerHTML = svg('check', 13);
    $('#savedInfo').append(` ${tr('Already saved in', 'Ya está guardado en')} ${pathLabel(existing.parentId)}${existing.dateAdded ? ` · ${timeAgo(existing.dateAdded)}` : ''}`);
    nameI.value = existing.title || '';
    selected = existing.parentId;
  } else {
    nameI.value = pageTitle || domainOf(pageUrl);
    selected = await lastSaveFolder();
    if (!nodeById.has(selected)) selected = root.children?.[0]?.id;
  }
  picker = folderPicker({
    roots: root.children || [], value: selected, recent: await recentFolders(),
    label: tr('Folder', 'Carpeta'),
    onChange: syncNewFolderHint,
    onActivate: () => $('#form').requestSubmit(),
  });
  picker.input.setAttribute('aria-labelledby', 'folderLabel');
  $('#folderPicker').append(picker.el);
  syncNewFolderHint();

  nameI.focus();
  nameI.select();

  const lb = $('#btnLang');
  lb.textContent = languageButtonText();
  lb.title = languageButtonTitle();
  lb.addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'es' : 'en');
    location.reload();
  });
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = nameI.value.trim() || domainOf(pageUrl);
  await perform(async () => {
    if (!normalizeUrl(pageUrl, { addScheme: false })) throw new Error(tr('This page cannot be bookmarked.', 'Esta página no se puede guardar.'));
    const folderId = picker.value;
    if (!folderId) throw new Error(tr('Choose a folder.', 'Elige una carpeta.'));
    if (existing) {
      await bm.update(existing.id, { title });
      if (folderId !== existing.parentId) await bm.move(existing.id, { parentId: folderId });
    } else {
      await bm.create({ parentId: folderId, title, url: pageUrl });
    }
    await rememberSaveFolder(folderId);
    notifyBadge('saved');
    done();
  });
});

// crear carpeta nueva dentro de la carpeta seleccionada
const newFolderRow = $('#newFolderRow');
const newFolderName = $('#newFolderName');

$('#btnNewFolder').addEventListener('click', () => {
  newFolderRow.hidden = !newFolderRow.hidden;
  if (!newFolderRow.hidden) { newFolderName.value = ''; newFolderName.focus(); }
});

async function createFolder() {
  const title = newFolderName.value.trim();
  if (!title) { newFolderName.focus(); return; }
  await perform(async () => {
    const created = await bm.create({ parentId: picker.value, title });
    const [root] = await bm.getTree();
    indexTree(root);
    picker.setRoots(root.children || [], created.id);
    syncNewFolderHint();
    newFolderRow.hidden = true;
    nameI.focus();
  });
}
$('#btnCreateFolder').addEventListener('click', createFolder);

$('#form').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if (e.target === newFolderName) createFolder();
  else $('#form').requestSubmit();
});

$('#btnRemove').addEventListener('click', async () => {
  await perform(async () => {
    if (existing) await bm.remove(existing.id);
    notifyBadge('removed');
    done();
  });
});

$('#btnCancel').addEventListener('click', done);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (busy) return;
  if (!newFolderRow.hidden) { newFolderRow.hidden = true; nameI.focus(); }
  else done();
});

init().catch(showError);
