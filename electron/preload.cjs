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

  // Search spreadsheets by name across My Drive, Shared Drives, and Shared with Me.
  // Returns: [{ id, name, mimeType, modifiedTime, webViewLink }]
  searchSheets: (query) => ipcRenderer.invoke('drive:searchSheets', query),

  // Tell main whether the Drive launcher is open so it can move the sheet view
  toggleLauncher: (isOpen) => ipcRenderer.send('launcher:toggle', isOpen),

  // Tell main whether the command bar palette dropdown is open.
  // Main moves the sheet view off-screen so the dropdown is clickable.
  togglePalette: (isOpen) => ipcRenderer.send('palette:toggle', isOpen),

  // Navigate back to the home screen — main restores homeIsVisible.
  goHome: () => ipcRenderer.send('home:show'),

  // Create a new flow spreadsheet in the given Drive folder.
  // Params: { name: string, folderId: string, format: 'Policy'|'LD'|'PF' }
  // Returns: { id, name, webViewLink }
  createFlowSheet: (params) => ipcRenderer.invoke('drive:createSheet', params),

  // Upload a local .xlsx file as a new Google Sheet in the given Drive folder.
  // Params: { name: string, folderId: string, filePath: string }
  createFlowFromTemplate: (params) => ipcRenderer.invoke('drive:createFromTemplate', params),

  // Format→template links
  getFormatLinks: ()                         => ipcRenderer.invoke('formatLinks:get'),
  setFormatLink:  (format, templateId)       => ipcRenderer.invoke('formatLinks:set', { format, templateId }),

  // ── Templates ────────────────────────────────────────────────────────────
  // User-added .xlsx template files stored locally.
  getTemplates: ()     => ipcRenderer.invoke('templates:get'),
  addTemplate:  ()     => ipcRenderer.invoke('templates:add'),     // opens file picker
  removeTemplate: (id) => ipcRenderer.invoke('templates:remove', id),

  // Add a new tab (sheet) to the currently open spreadsheet.
  // Params: { spreadsheetId: string, tabName: string, format: 'Policy'|'LD'|'PF' }
  addFlowTab: (params) => ipcRenderer.invoke('sheet:addTab', params),

  // ── Tubs ─────────────────────────────────────────────────────────────────
  // Local .docx block files (1AR, blocks, answers, etc.)
  getTubs:    ()     => ipcRenderer.invoke('tubs:get'),
  addTub:     ()     => ipcRenderer.invoke('tubs:add'),            // opens file picker
  removeTub:  (id)   => ipcRenderer.invoke('tubs:remove', id),

  // Main → Renderer: auth completed (e.g. triggered externally).
  // Returns an unsubscribe function.
  onAuthComplete: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('auth:complete', handler);
    return () => ipcRenderer.off('auth:complete', handler);
  },
});
