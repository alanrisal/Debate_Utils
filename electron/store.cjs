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

module.exports = { getTokens, setTokens, getUserInfo, setUserInfo, clearAll };
