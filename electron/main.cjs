'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, WebContentsView, dialog } = require('electron');
const path = require('path');
const { randomUUID } = require('crypto');

// Load .env before anything that reads process.env
try {
  const fs = require('fs');
  const lines = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch { /* .env not found — env vars must be set externally */ }

const { getTokens, setTokens, getUserInfo, setUserInfo, clearAll,
        getTemplates, saveTemplates, getTubs, saveTubs,
        getFormatLinks, saveFormatLinks } = require('./store.cjs');
const { startAuthFlow, buildClientFromTokens } = require('./auth.cjs');
const { listFolder, listSharedWithMe, listSharedDrives,
        createFlowSheet, createFlowFromTemplate, addFlowTab,
        searchSheets } = require('./sheets-api.cjs');

// ── Constants ────────────────────────────────────────────────────────────────

const PANEL_WIDTH    = 300;  // px — matches BlockPanel.svelte width
const TOOLBAR_HEIGHT = 48;   // px — matches Toolbar.svelte height

// ── State ────────────────────────────────────────────────────────────────────

let mainWindow      = null;
let sheetView       = null;
let panelOpen       = false;
let launcherIsOpen  = false;   // Drive launcher overlay is open
let paletteIsOpen   = false;   // command palette dropdown is open
let sheetActive     = false;   // a sheet URL has been loaded (off = home screen)
let oauth2Client    = null;
let currentUserInfo = null;
let currentSheetUrl = '';      // last URL loaded in the sheet view

// ── Helpers ──────────────────────────────────────────────────────────────────

function sheetViewBounds() {
  const [w, h] = mainWindow.getContentSize();
  // Move the native WebContentsView completely off-screen whenever any Svelte
  // overlay needs to be visible and clickable (home screen, launcher, palette).
  if (!sheetActive || launcherIsOpen || paletteIsOpen) {
    return { x: 0, y: h + TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT };
  }
  return {
    x:      0,
    y:      TOOLBAR_HEIGHT,
    width:  w - (panelOpen ? PANEL_WIDTH : 0),
    height: h - TOOLBAR_HEIGHT,
  };
}

// ── Auth bootstrap ───────────────────────────────────────────────────────────

async function initAuth() {
  const tokens = await getTokens();
  if (!tokens) return;

  try {
    const userInfo = await getUserInfo();
    oauth2Client = buildClientFromTokens(tokens);
    currentUserInfo = userInfo;

    // Save refreshed tokens automatically when googleapis rotates them
    oauth2Client.on('tokens', async (newTokens) => {
      const existing = await getTokens();
      await setTokens({ ...existing, ...newTokens });
    });
  } catch (err) {
    console.error('initAuth: failed to restore session', err);
    oauth2Client = null;
    currentUserInfo = null;
  }
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:    1400,
    height:   900,
    minWidth:  900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  // Dev: Vite dev server. Prod: built index.html.
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    attachSheetView();
  });

  // Keep the sheet view sized to the window.
  mainWindow.on('resize', () => {
    if (sheetView) sheetView.setBounds(sheetViewBounds());
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    sheetView  = null;
  });
}

// ── Sheet BrowserView (WebContentsView) ──────────────────────────────────────

function attachSheetView() {
  sheetView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.contentView.addChildView(sheetView);
  sheetView.setBounds(sheetViewBounds());
  // Start blank — user opens a sheet via the toolbar URL bar or Drive launcher.
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Renderer tells main the panel opened or closed → resize the sheet view.
ipcMain.on('panel:toggle', (_e, isOpen) => {
  panelOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

// Renderer asks main to load a sheet URL — bring the view on-screen.
ipcMain.on('sheet:open', (_e, url) => {
  currentSheetUrl = url;
  sheetActive     = true;
  if (sheetView) {
    sheetView.webContents.loadURL(url);
    sheetView.setBounds(sheetViewBounds());
  }
});

// Renderer navigated back to home — push the sheet view off-screen so the
// Home.svelte component (in the BrowserWindow layer) is visible and clickable.
ipcMain.on('home:show', () => {
  sheetActive = false;
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

// Renderer tells main the Drive launcher opened or closed.
ipcMain.on('launcher:toggle', (_e, isOpen) => {
  launcherIsOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

// Renderer tells main the command palette dropdown opened or closed.
// The palette is a Svelte element in the BrowserWindow layer; the native
// WebContentsView must be moved off-screen so the dropdown is clickable.
ipcMain.on('palette:toggle', (_e, isOpen) => {
  paletteIsOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

// Renderer close button.
ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// ── Auth / Drive IPC handlers ─────────────────────────────────────────────────

ipcMain.handle('auth:status', () => {
  return {
    loggedIn:       !!oauth2Client,
    userInfo:       currentUserInfo,
    hasCredentials: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  };
});

ipcMain.handle('auth:start', async () => {
  const { tokens, userInfo, client } = await startAuthFlow();

  await setTokens(tokens);
  await setUserInfo(userInfo);

  oauth2Client    = client;
  currentUserInfo = userInfo;

  // Save refreshed tokens automatically
  oauth2Client.on('tokens', async (newTokens) => {
    const existing = await getTokens();
    await setTokens({ ...existing, ...newTokens });
  });

  const result = { loggedIn: true, userInfo };

  // Notify any open windows (e.g. if auth was triggered from outside Launcher)
  if (mainWindow) {
    mainWindow.webContents.send('auth:complete', result);
  }

  return result;
});

ipcMain.handle('auth:logout', async () => {
  await clearAll();
  oauth2Client    = null;
  currentUserInfo = null;
  return { loggedIn: false };
});

ipcMain.handle('drive:listFolder', async (_e, folderId) => {
    if (!oauth2Client) throw new Error('Not authenticated');
    const files = await listFolder(oauth2Client, folderId);
    // console.log('listFolder result:', files.map(f => ({ name: f.name, mimeType: f.mimeType })));     
    return files;
  });

ipcMain.handle('drive:listSharedWithMe', async () => {
  if (!oauth2Client) throw new Error('Not authenticated');
  return listSharedWithMe(oauth2Client);
});

ipcMain.handle('drive:listSharedDrives', async () => {
  if (!oauth2Client) throw new Error('Not authenticated');
  return listSharedDrives(oauth2Client);
});

ipcMain.handle('drive:searchSheets', async (_e, query) => {
  if (!oauth2Client) throw new Error('Not authenticated');
  return searchSheets(oauth2Client, query);
});

// ── Template handlers ─────────────────────────────────────────────────────────

ipcMain.handle('templates:get', async () => {
  return getTemplates();
});

ipcMain.handle('templates:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Template (.xlsx)',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  const name     = path.basename(filePath, '.xlsx');
  const newTmpl  = { id: randomUUID(), name, filePath };
  const existing = await getTemplates();
  await saveTemplates([...existing, newTmpl]);
  return newTmpl;
});

ipcMain.handle('templates:remove', async (_e, id) => {
  const existing = await getTemplates();
  await saveTemplates(existing.filter(t => t.id !== id));
});

// ── Tubs (local .docx block files) handlers ───────────────────────────────────

ipcMain.handle('tubs:get', async () => {
  return getTubs();
});

ipcMain.handle('tubs:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Block Files (.docx)',
    filters: [{ name: 'Word Documents', extensions: ['docx'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || filePaths.length === 0) return [];
  const existing = await getTubs();
  const added    = filePaths.map(fp => ({
    id:       randomUUID(),
    name:     path.basename(fp, '.docx'),
    filePath: fp,
  }));
  await saveTubs([...existing, ...added]);
  return added;
});

ipcMain.handle('tubs:remove', async (_e, id) => {
  const existing = await getTubs();
  await saveTubs(existing.filter(t => t.id !== id));
});

// ── Format-link handlers ──────────────────────────────────────────────────────

ipcMain.handle('formatLinks:get', async () => {
  return getFormatLinks();
});

ipcMain.handle('formatLinks:set', async (_e, { format, templateId }) => {
  const links   = await getFormatLinks();
  const updated = { ...links, [format]: templateId ?? null };
  await saveFormatLinks(updated);
  return updated;
});

// ── Drive / Sheet creation handlers ──────────────────────────────────────────

ipcMain.handle('drive:createSheet', async (_e, params) => {
  if (!oauth2Client) throw new Error('Not authenticated');
  return createFlowSheet(oauth2Client, params);
});

ipcMain.handle('drive:createFromTemplate', async (_e, params) => {
  if (!oauth2Client) throw new Error('Not authenticated');
  return createFlowFromTemplate(oauth2Client, params);
});

// ── Sheet tab handler ─────────────────────────────────────────────────────────

ipcMain.handle('sheet:addTab', async (_e, { spreadsheetId, tabName, format }) => {
  if (!oauth2Client) throw new Error('Not authenticated');

  // If the current format has a user-linked template, copy the first (blank
  // template) sheet so the new tab inherits the template's formatting instead
  // of getting a bare sheet with just column headers.
  const formatLinks     = await getFormatLinks();
  const copyFirstSheet  = !!(formatLinks && formatLinks[format]);

  const result = await addFlowTab(oauth2Client, { spreadsheetId, tabName, format, copyFirstSheet });

  // Navigate the embedded sheet to the new tab
  if (sheetView && currentSheetUrl) {
    const base = currentSheetUrl.split('#')[0];
    sheetView.webContents.loadURL(`${base}#gid=${result.sheetId}`);
  }
  return result;
});



// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initAuth();
  createWindow();

  // Ctrl+K / Cmd+K toggles the block panel.
  globalShortcut.register('CommandOrControl+K', () => {
    if (!mainWindow) return;
    panelOpen = !panelOpen;
    if (sheetView) sheetView.setBounds(sheetViewBounds());
    mainWindow.webContents.send('panel:toggle', panelOpen);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});
