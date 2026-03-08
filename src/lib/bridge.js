/**
 * bridge.js — window.flowkit compatibility layer for Chrome Extension
 *
 * Exposes the same API surface as the Electron preload.cjs contextBridge so
 * every existing Svelte component works without modification. All calls that
 * previously went to the Electron main process via IPC now go to either:
 *   - The service worker  (chrome.runtime.sendMessage)
 *   - Chrome tabs API     (opening / injecting into Sheets tabs)
 *   - Local state         (panel toggles, CEF events — irrelevant in extension)
 *
 * USAGE
 * ──────
 * In src/main.js, before mounting the Svelte app:
 *   import { flowkit } from './lib/bridge.js';
 *   window.flowkit = flowkit;
 *
 * Then all existing window.flowkit.* calls in components work unchanged.
 */

// ── Service worker messaging ──────────────────────────────────────────────────

function sw(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (response?.error) return reject(new Error(response.error));
      resolve(response?.data ?? response);
    });
  });
}

// ── File picker helper ─────────────────────────────────────────────────────────
// Used for addTub() and addTemplate() — replaces dialog.showOpenDialog from Electron.
// Returns a Promise that resolves with an array of { name, data: Array<number> }.

function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const input    = Object.assign(document.createElement('input'), {
      type:     'file',
      accept,
      multiple,
      style:    'display:none',
    });
    document.body.appendChild(input);

    input.onchange = async () => {
      const files = Array.from(input.files);
      document.body.removeChild(input);
      const results = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          data: Array.from(new Uint8Array(await f.arrayBuffer())),
        }))
      );
      resolve(results);
    };

    // If the user cancels the picker, oncancel fires in modern Chrome.
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve([]);
    });

    input.click();
  });
}

// ── Sheet tab helpers ─────────────────────────────────────────────────────────

async function findOrOpenSheet(url) {
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/spreadsheets/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ── Local event bus ───────────────────────────────────────────────────────────
// Replaces Electron IPC push events (panel:toggle, panel:focus-search, auth:complete).
// Components subscribe via onPanelToggle / onPanelFocusSearch / onAuthComplete.
// Dispatch these custom events from the sidebar's own logic when needed.

function localOn(eventName, cb) {
  const handler = (e) => cb(e.detail);
  window.addEventListener(eventName, handler);
  return () => window.removeEventListener(eventName, handler);
}

export function dispatchLocal(eventName, detail) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

// ── The bridge object ─────────────────────────────────────────────────────────

export const flowkit = {
  // Chrome Extension doesn't have a meaningful platform for macOS traffic lights,
  // but we expose it so components that read it don't throw.
  platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',

  // ── Window / Shell ──────────────────────────────────────────────────────────
  // In the extension there's no native window to close.  goHome is local state.
  closeWindow:   () => window.close(),
  goHome:        () => dispatchLocal('flowkit:goHome', null),

  // ── Sheet navigation ─────────────────────────────────────────────────────────
  openSheet: (url) => findOrOpenSheet(url),

  // ── Panel / overlay toggles ──────────────────────────────────────────────────
  // In the extension the sidebar IS the overlay — there is no WebContentsView to
  // move off-screen.  These are kept for API compatibility but are no-ops or
  // purely local-state operations.
  togglePanel:   () => dispatchLocal('flowkit:panelToggle', null),
  toggleLauncher: () => {},   // noop — no WebContentsView layer
  togglePalette:  () => {},   // noop
  toggleToast:    () => Promise.resolve(),

  // ── Auth ─────────────────────────────────────────────────────────────────────
  startAuth:     () => sw('auth:start'),
  getAuthStatus: () => sw('auth:status'),
  logout:        () => sw('auth:logout'),

  // Chrome extensions don't have the CEF embedded-browser problem.
  onCefBlocked:         () => () => {},
  onChromeSigningIn:    () => () => {},
  onChromeSignInComplete: () => () => {},
  triggerChromeSignIn:  () => Promise.resolve({ success: true }),

  // ── Event subscriptions (panel / auth) ───────────────────────────────────────
  onPanelToggle:     (cb) => localOn('flowkit:panelToggle', cb),
  onPanelFocusSearch:(cb) => localOn('flowkit:focusSearch',  cb),
  onAuthComplete:    (cb) => localOn('flowkit:authComplete', cb),

  // ── Drive ────────────────────────────────────────────────────────────────────
  listFolder:         (folderId) => sw('drive:listFolder',      { folderId }),
  listSharedWithMe:   ()         => sw('drive:listSharedWithMe'),
  listSharedDrives:   ()         => sw('drive:listSharedDrives'),
  searchSheets:       (query)    => sw('drive:searchSheets',    { query }),
  createFlowSheet:    (params)   => sw('drive:createSheet',     params),
  createFlowFromTemplate: (params) => sw('drive:createFromTemplate', params),

  // ── Recents ──────────────────────────────────────────────────────────────────
  getRecentSheets: ()      => sw('recent:get'),
  addRecentSheet:  (entry) => sw('recent:add', entry),

  // ── Templates ────────────────────────────────────────────────────────────────
  getTemplates:   () => sw('templates:get'),
  removeTemplate: (id) => sw('templates:remove', { id }),

  addTemplate: async () => {
    const files = await pickFiles('.xlsx', false);
    if (!files.length) return null;
    const { name, data } = files[0];
    const cleanName = name.replace(/\.xlsx$/i, '');
    return sw('templates:add', { name: cleanName, fileData: data });
  },

  // ── Format links ─────────────────────────────────────────────────────────────
  getFormatLinks: ()                    => sw('formatLinks:get'),
  setFormatLink:  (format, templateId) => sw('formatLinks:set', { format, templateId }),

  // ── Sheet tabs ───────────────────────────────────────────────────────────────
  addFlowTab:       (params)         => sw('sheet:addTab',      params),
  fixSheetWrapping: (spreadsheetId)  => sw('sheet:fixWrapping', { spreadsheetId }),

  // ── Tubs ─────────────────────────────────────────────────────────────────────
  getTubs:    ()    => sw('tubs:get'),
  removeTub:  (id)  => sw('tubs:remove', { id }),
  parseAllTubs: ()  => sw('tubs:parseAll'),
  loadTubBlocks: (tubId) => sw('tubs:getBlocks', { tubId }),

  addTub: async () => {
    const files = await pickFiles('.docx', true);
    if (!files.length) return [];
    const added = [];
    for (const { name, data } of files) {
      const result = await sw('tubs:add', { fileName: name, fileData: data });
      if (result) added.push(result);
    }
    return added;
  },

  // ── Block injection ───────────────────────────────────────────────────────────
  injectBlock: (content) => sw('blocks:inject', { content }),

  // ── Cell navigation (sidebar arrow keys) ─────────────────────────────────────
  // Called by BlockPanel when the user presses an arrow key with an empty query.
  // The service worker updates sheetState and fires the batchUpdate highlight.
  setTargetCell: (params) => sw('cell:setTarget', params),
};
