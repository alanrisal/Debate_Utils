'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, WebContentsView } = require('electron');
const path = require('path');

// Load .env before anything that reads process.env
try {
  const fs = require('fs');
  const lines = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch { /* .env not found — env vars must be set externally */ }

const { getTokens, setTokens, getUserInfo, setUserInfo, clearAll } = require('./store.cjs');
const { startAuthFlow, buildClientFromTokens } = require('./auth.cjs');
const { listFolder, listSharedWithMe, listSharedDrives } = require('./sheets-api.cjs');

// ── Constants ────────────────────────────────────────────────────────────────

const PANEL_WIDTH    = 300;  // px — matches BlockPanel.svelte width
const TOOLBAR_HEIGHT = 48;   // px — matches Toolbar.svelte height

// ── State ────────────────────────────────────────────────────────────────────

let mainWindow      = null;
let sheetView       = null;
let panelOpen       = false;
let launcherIsOpen  = false;   // tracks whether the Drive launcher modal is showing
let oauth2Client    = null;
let currentUserInfo = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sheetViewBounds() {
  const [w, h] = mainWindow.getContentSize();
  if (launcherIsOpen) {
    // Push the sheet view entirely below the visible window so the Svelte
    // Launcher overlay (which lives in the BrowserWindow content layer)
    // can receive mouse/keyboard events unobstructed.
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

// Renderer asks main to load a different sheet URL.
ipcMain.on('sheet:open', (_e, url) => {
  if (sheetView) sheetView.webContents.loadURL(url);
});

// Renderer tells main the Drive launcher opened or closed.
// We move the sheet view off-screen while the launcher is visible so the
// Svelte overlay (which lives below the native WebContentsView) can be clicked.
ipcMain.on('launcher:toggle', (_e, isOpen) => {
  launcherIsOpen = Boolean(isOpen);
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
    console.log('listFolder result:', files.map(f => ({ name: f.name, mimeType: f.mimeType })));     
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
