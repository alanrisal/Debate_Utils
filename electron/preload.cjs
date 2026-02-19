'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowkit', {
  // ── Sheet ──────────────────────────────────────────────────────────────────

  // Renderer → Main: load a sheet URL in the WebContentsView
  openSheet: (url) => ipcRenderer.send('sheet:open', url),

  // Renderer → Main: close the window
  closeWindow: () => ipcRenderer.send('window:close'),

  // Main → Renderer: panel toggled via Ctrl+K global shortcut.
  // Returns an unsubscribe function — call it in onDestroy/onMount cleanup.
  onPanelToggle: (cb) => {
    const handler = (_e, isOpen) => cb(isOpen);
    ipcRenderer.on('panel:toggle', handler);
    return () => ipcRenderer.off('panel:toggle', handler);
  },

  // ── Auth / Drive ───────────────────────────────────────────────────────────

  // Trigger OAuth PKCE flow — opens system browser, returns { loggedIn, userInfo }
  startAuth: () => ipcRenderer.invoke('auth:start'),

  // Check current auth state — returns { loggedIn, userInfo, hasCredentials }
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),

  // Sign out and clear stored tokens
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Navigate Drive: list folders + sheets inside a folder.
  listFolder: (folderId) => ipcRenderer.invoke('drive:listFolder', folderId),

  // List spreadsheets shared directly with the user.
  listSharedWithMe: () => ipcRenderer.invoke('drive:listSharedWithMe'),

  // List Shared Drives the user is a member of.
  listSharedDrives: () => ipcRenderer.invoke('drive:listSharedDrives'),

  // Tell main whether the Drive launcher is open so it can move the sheet view
  toggleLauncher: (isOpen) => ipcRenderer.send('launcher:toggle', isOpen),

  // Main → Renderer: auth completed (e.g. triggered externally).
  // Returns an unsubscribe function.
  onAuthComplete: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('auth:complete', handler);
    return () => ipcRenderer.off('auth:complete', handler);
  },
});
