'use strict';

// electron-store v11 is ESM-only. Lazy-load it via dynamic import()
// so this CJS module can still export a synchronous-looking surface.

let _store = null;

async function getStore() {
  if (_store) return _store;
  const { default: Store } = await import('electron-store');
  _store = new Store({ name: 'flowkit' });
  return _store;
}

async function getTokens() {
  const s = await getStore();
  return s.get('tokens', null);
}

async function setTokens(tokens) {
  const s = await getStore();
  s.set('tokens', tokens);
}

async function getUserInfo() {
  const s = await getStore();
  return s.get('userInfo', null);
}

async function setUserInfo(info) {
  const s = await getStore();
  s.set('userInfo', info);
}

async function clearAll() {
  const s = await getStore();
  s.clear();
}

// ── User templates ────────────────────────────────────────────────────────────
// Each entry: { id, name, filePath }
async function getTemplates() {
  const s = await getStore();
  return s.get('userTemplates', []);
}

async function saveTemplates(templates) {
  const s = await getStore();
  s.set('userTemplates', templates);
}

// ── Tubs (local .docx block files) ───────────────────────────────────────────
// Each entry: { id, name, filePath }
async function getTubs() {
  const s = await getStore();
  return s.get('tubs', []);
}

async function saveTubs(tubs) {
  const s = await getStore();
  s.set('tubs', tubs);
}

// ── Format links (custom template override per built-in format) ───────────────
// Shape: { Policy: templateId|null, LD: templateId|null, PF: templateId|null }
async function getFormatLinks() {
  const s = await getStore();
  return s.get('formatLinks', { Policy: null, LD: null, PF: null });
}

async function saveFormatLinks(links) {
  const s = await getStore();
  s.set('formatLinks', links);
}

// ── Recent sheets ─────────────────────────────────────────────────────────────
// Each entry: { id, name, url, openedAt }
async function getRecentSheets() {
  const s = await getStore();
  return s.get('recentSheets', []);
}

async function addRecentSheet({ id, name, url }) {
  const s = await getStore();
  let recents = s.get('recentSheets', []);
  recents = recents.filter(r => r.id !== id);
  recents.unshift({ id, name, url, openedAt: new Date().toISOString() });
  if (recents.length > 10) recents = recents.slice(0, 10);
  s.set('recentSheets', recents);
}

module.exports = { getTokens, setTokens, getUserInfo, setUserInfo, clearAll, getTemplates, saveTemplates, getTubs, saveTubs, getFormatLinks, saveFormatLinks, getRecentSheets, addRecentSheet };
