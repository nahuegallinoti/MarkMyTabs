import { IS_EXT, loadPref, savePref } from '../common/utils.js';

// Revisión de enlaces rotos. Necesita el permiso opcional de hosts (lo pide el administrador).
// Las consultas van directo a cada sitio, sin cookies ni referrer.

const TIMEOUT = 12000;
const CONCURRENCY = 6;
const AUTH_PAGE = /(^|[./-])(login|signin|sign-in|auth|sso|account|accounts|consent)([./-]|$)/i;

export async function loadLinkReport() {
  if (IS_EXT) {
    try { return (await chrome.storage.local.get('linkReport')).linkReport || null; }
    catch { return null; }
  }
  return loadPref('mp-link-report', null);
}

export async function saveLinkReport(report) {
  if (IS_EXT) {
    try { await chrome.storage.local.set({ linkReport: report }); } catch { /* el informe se puede regenerar */ }
  } else savePref('mp-link-report', report);
}

async function request(url, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method, credentials: 'omit', redirect: 'follow', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctrl.signal });
    if (method === 'GET') ctrl.abort(); // el cuerpo no hace falta
    return { status: r.status, finalUrl: r.url, redirected: r.redirected };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

const comparable = (u) => {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '');
  } catch { return u; }
};

// Solo cuenta como mudanza si cambia el sitio o la ruta, y no termina en una pantalla de inicio de sesión.
function meaningfulRedirect(from, to) {
  if (!to || comparable(from) === comparable(to)) return false;
  try {
    const x = new URL(to);
    return !AUTH_PAGE.test(x.hostname.split('.')[0]) && !AUTH_PAGE.test(x.pathname);
  } catch { return false; }
}

export async function checkUrl(url) {
  let r = await request(url, 'HEAD');
  // Muchos servidores responden mal a HEAD: se confirma con GET antes de marcar un problema.
  if (r.error === 'network' || r.status >= 400 || r.status === 0) r = await request(url, 'GET');
  if (r.error === 'network') return { kind: 'broken', reason: 'network' };
  if (r.error === 'timeout') return { kind: 'unverified', reason: 'timeout' };
  if (r.status === 404 || r.status === 410) return { kind: 'broken', status: r.status };
  if (r.status >= 400 || r.status === 0) return { kind: 'unverified', status: r.status };
  if (r.redirected && meaningfulRedirect(url, r.finalUrl)) return { kind: 'redirect', finalUrl: r.finalUrl };
  return { kind: 'ok' };
}

// Resultados simulados para el modo de desarrollo (sin red ni permisos).
async function mockCheck(url) {
  await new Promise(r => setTimeout(r, 20 + Math.random() * 60));
  if (/netflix/.test(url)) return { kind: 'broken', status: 404 };
  if (/cookpad/.test(url)) return { kind: 'broken', reason: 'network' };
  if (/booking\.com/.test(url)) return { kind: 'redirect', finalUrl: 'https://www.booking.com/index.es.html' };
  if (/reddit/.test(url)) return { kind: 'unverified', status: 403 };
  return { kind: 'ok' };
}

export async function checkLinks(urls, { mock = false, shouldStop = () => false, onResult } = {}) {
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !shouldStop()) {
      const url = urls[next++];
      let result;
      try { result = await (mock ? mockCheck(url) : checkUrl(url)); }
      catch { result = { kind: 'unverified', reason: 'timeout' }; }
      if (shouldStop()) return;
      onResult?.(url, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
}
