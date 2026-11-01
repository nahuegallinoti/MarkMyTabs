import { el, svg, normalize } from './utils.js';
import { tr } from './i18n.js';

let seq = 0;

// Selector de carpetas con filtro y atajos a carpetas recientes. Escribir en el filtro
// elige la primera coincidencia, así «Alt+M, Tab, dev, Enter» guarda en «Dev».
export function folderPicker({ roots, value = null, recent = [], isDisabled = () => false, onChange, onActivate, label }) {
  const uid = `fp${++seq}`;
  let folders = [];
  let byId = new Map();
  let selected = null;
  let visible = [];

  const filter = el('input', {
    type: 'text', class: 'fp-filter', autocomplete: 'off', spellcheck: 'false',
    placeholder: tr('Search folders…', 'Buscar carpeta…'),
    role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list',
    'aria-controls': `${uid}-list`, 'aria-label': label || tr('Folder', 'Carpeta'),
  });
  const chips = el('div', { class: 'fp-recent' });
  const list = el('div', { class: 'fp-list', role: 'listbox', id: `${uid}-list`, tabindex: '-1', 'aria-label': label || tr('Folders', 'Carpetas') });
  const wrap = el('div', { class: 'fp' }, chips, filter, list);

  function index(nextRoots) {
    folders = [];
    (function walk(nodes, depth, trail) {
      for (const n of nodes) {
        if (n.url) continue;
        const title = n.title || tr('Untitled', 'Sin nombre');
        const path = [...trail, title];
        folders.push({ id: n.id, depth, title, parent: trail.join(' / '), key: normalize(path.join(' / ')), titleKey: normalize(title), disabled: !!isDisabled(n.id) });
        walk(n.children || [], depth + 1, path);
      }
    })(nextRoots, 0, []);
    byId = new Map(folders.map(f => [f.id, f]));
  }

  function select(id, { scroll = true, notify = true } = {}) {
    const f = byId.get(id);
    if (!f || f.disabled) return;
    const changed = selected !== id;
    selected = id;
    for (const row of list.children) {
      const on = row.dataset.id === id;
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', String(on));
      if (on && scroll) ensureVisible(row);
    }
    filter.setAttribute('aria-activedescendant', `${uid}-${id}`);
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.id === id));
    if (changed && notify) onChange?.(id);
  }

  function ensureVisible(row) {
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }

  function renderChips(ids) {
    chips.replaceChildren();
    for (const id of ids.filter(i => byId.has(i) && !byId.get(i).disabled).slice(0, 5)) {
      const f = byId.get(id);
      chips.append(el('button', {
        type: 'button', class: 'fp-chip', dataset: { id }, title: f.parent ? `${f.parent} / ${f.title}` : f.title,
        'aria-pressed': String(id === selected),
        onClick: () => { filter.value = ''; render(); select(id); },
      }, el('span', { class: 'icn', html: svg('clock', 12) }), el('span', { text: f.title })));
    }
    chips.hidden = !chips.children.length;
  }

  function render() {
    const tokens = normalize(filter.value).split(/\s+/).filter(Boolean);
    visible = tokens.length
      ? folders.filter(f => tokens.every(t => f.key.includes(t)))
        .sort((a, b) => Number(!tokens.every(t => a.titleKey.includes(t))) - Number(!tokens.every(t => b.titleKey.includes(t))))
      : folders;
    list.replaceChildren();
    for (const f of visible) {
      const row = el('div', {
        class: `fp-row${f.id === selected ? ' selected' : ''}`, role: 'option', id: `${uid}-${f.id}`,
        dataset: { id: f.id }, 'aria-selected': String(f.id === selected), 'aria-disabled': f.disabled ? 'true' : null,
        style: tokens.length ? null : `padding-left:${8 + f.depth * 14}px`,
      },
        el('span', { class: 'icn', html: svg('folder', 14) }),
        el('span', { class: 'fp-title', text: f.title }),
        tokens.length && f.parent ? el('span', { class: 'fp-path', text: f.parent }) : null);
      list.append(row);
    }
    if (!visible.length) list.append(el('div', { class: 'fp-empty', text: tr('No matching folders', 'No hay carpetas que coincidan') }));
    if (tokens.length && !visible.some(f => f.id === selected && !f.disabled)) {
      const first = visible.find(f => !f.disabled);
      if (first) select(first.id);
    } else if (selected) {
      const row = list.querySelector(`[data-id="${CSS.escape(selected)}"]`);
      if (row) requestAnimationFrame(() => ensureVisible(row));
    }
  }

  function step(delta) {
    const enabled = visible.filter(f => !f.disabled);
    if (!enabled.length) return;
    const i = enabled.findIndex(f => f.id === selected);
    const next = enabled[Math.max(0, Math.min(enabled.length - 1, i === -1 ? 0 : i + delta))];
    select(next.id);
  }

  filter.addEventListener('input', render);
  filter.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); e.stopPropagation(); step(e.key === 'PageDown' ? 8 : -8); }
    else if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); filter.value = ''; render(); }
  });
  list.addEventListener('click', e => {
    const row = e.target.closest('.fp-row');
    if (row && row.getAttribute('aria-disabled') !== 'true') select(row.dataset.id, { scroll: false });
  });
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('.fp-row');
    if (row && row.getAttribute('aria-disabled') !== 'true') { select(row.dataset.id, { scroll: false }); onActivate?.(row.dataset.id); }
  });

  function setRoots(nextRoots, nextValue = selected, nextRecent = recent) {
    index(nextRoots);
    recent = nextRecent;
    selected = byId.has(nextValue) && !byId.get(nextValue).disabled ? nextValue : null;
    renderChips(recent);
    render();
    if (selected) select(selected, { notify: false });
  }

  setRoots(roots, value, recent);

  return {
    el: wrap,
    input: filter,
    get value() { return selected; },
    set value(id) { select(id, { notify: false }); },
    setRoots,
    focus: () => filter.focus(),
  };
}
