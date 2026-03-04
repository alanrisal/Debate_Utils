'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, WebContentsView, dialog, clipboard } = require('electron');
const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

// Load .env before anything that reads process.env.
// In a packaged app, .env lives in process.resourcesPath (bundled via extraResources).
// In development, it lives next to package.json (one level above electron/).
const ENV_PATHS = [
  path.join(process.resourcesPath ?? '', '.env'), // packaged
  path.join(__dirname, '../.env'),                 // development
];
for (const envPath of ENV_PATHS) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
    break; // stop at the first .env that loads successfully
  } catch { /* try next path */ }
}

const { getTokens, setTokens, getUserInfo, setUserInfo, clearAll,
        getTemplates, saveTemplates, getTubs, saveTubs,
        getFormatLinks, saveFormatLinks,
        getRecentSheets, addRecentSheet } = require('./store.cjs');
const { startAuthFlow, buildClientFromTokens } = require('./auth.cjs');
const { listFolder, listSharedWithMe, listSharedDrives,
        createFlowSheet, createFlowFromTemplate, addFlowTab,
        searchSheets, fixSheetWrapping, getSheetTitle } = require('./sheets-api.cjs');
const { parseTub } = require('./parser.cjs');

// ── Constants ────────────────────────────────────────────────────────────────

const PANEL_WIDTH    = 300;  // px — matches BlockPanel.svelte width
const TOOLBAR_HEIGHT = 46;   // px — matches Toolbar.svelte height
const TOAST_HEIGHT   = 28;   // px — thin strip below toolbar for toast notifications

// ── State ────────────────────────────────────────────────────────────────────

let mainWindow      = null;
let sheetView       = null;
let panelOpen       = false;
let launcherIsOpen  = false;   // Drive launcher overlay is open
let paletteIsOpen   = false;   // command palette dropdown is open
let sheetActive     = false;   // a sheet URL has been loaded (off = home screen)
let toastVisible    = false;   // toast notification is visible — leave gap at bottom
let oauth2Client    = null;
let currentUserInfo = null;
let currentSheetUrl = '';      // last URL loaded in the sheet view

// Tracks spreadsheetIds that have had WRAP applied this session so we don't
// repeat the batchUpdate every time the user navigates back to the same sheet.
const wrappingFixedIds = new Set();

// ── Tub cache helpers ─────────────────────────────────────────────────────────
// Parsed .docx tubs are serialized as JSON next to the userData dir so the
// app never re-parses a file it has already seen. Cache is keyed by tub ID.

function tubCacheDir() {
  return path.join(app.getPath('userData'), 'tub-cache');
}

function tubCachePath(tubId) {
  return path.join(tubCacheDir(), `${tubId}.json`);
}

async function ensureTubParsed(tub) {
  const cachePath = tubCachePath(tub.id);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  const blocks = await parseTub(tub.filePath);
  fs.mkdirSync(tubCacheDir(), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(blocks));
  return blocks;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Convert a raw API / Gaxios error into a clean user-facing message.
// Throwing this keeps Electron's "Error occurred in handler" log clean
// and ensures the renderer catch block gets a readable string.
function friendlyError(e) {
  const raw = (e?.message || e?.toString() || 'unknown error').toLowerCase();
  if (raw.includes('not supported for this document'))
    return new Error('this document is not a native google sheet — excel files opened in drive don\'t support adding tabs');
  if (raw.includes('not authenticated') || raw.includes('invalid_grant') || raw.includes('token'))
    return new Error('not authenticated — please sign in again');
  if (raw.includes('permission') || raw.includes('forbidden') || raw.includes('403'))
    return new Error('permission denied — you may not have edit access to this sheet');
  if (raw.includes('not found') || raw.includes('404'))
    return new Error('document not found — it may have been deleted or moved');
  if (raw.includes('quota') || raw.includes('429'))
    return new Error('google api rate limit hit — try again in a moment');
  if (raw.includes('network') || raw.includes('enotfound') || raw.includes('econnrefused'))
    return new Error('network error — check your internet connection');
  // Fall back to the original message, stripped of any stack/gaxios boilerplate
  const clean = (e?.message || 'unexpected error').split('\n')[0].trim();
  return new Error(clean);
}

function sheetViewBounds() {
  const [w, h] = mainWindow.getContentSize();
  // Move the native WebContentsView completely off-screen whenever any Svelte
  // overlay needs to be visible and clickable (home screen, launcher, palette).
  if (!sheetActive || launcherIsOpen || paletteIsOpen) {
    return { x: 0, y: h + TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT };
  }
  const topOffset = TOOLBAR_HEIGHT + (toastVisible ? TOAST_HEIGHT : 0);
  return {
    x:      0,
    y:      topOffset,
    width:  w - (panelOpen ? PANEL_WIDTH : 0),
    height: h - topOffset,
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
    // Position the macOS traffic lights so they sit inside the 46px toolbar
    // without overlapping toolbar content. x:14 aligns them with the left
    // padding; y:15 centres the 16px buttons in the 46px bar ((46-16)/2=15).
    trafficLightPosition: { x: 14, y: 15 },
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
  // 'persist:flowkit-sheets' gives the WebContentsView its own cookie/storage
  // partition that survives across app restarts. Without this, every cold open
  // starts with zero Google session cookies and forces a full sign-in — which
  // is when Google's CEF detection triggers the "Sign in with a supported
  // browser" block. With persistence, users sign in once and stay signed in.
  sheetView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      partition:        'persist:flowkit-sheets',
    },
  });

  mainWindow.contentView.addChildView(sheetView);
  sheetView.setBounds(sheetViewBounds());

  // Grant clipboard read/write permissions so Google Sheets' Edit-menu
  // copy/cut/paste works without showing the "install Chrome extension" prompt.
  sheetView.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  // Google rejects Electron's default user agent (it contains "Electron/x.x.x")
  // on the first auth redirect and shows "unable to do so at this time".
  // Setting a current Chrome UA lets Google Sheets' login flow complete normally.
  // Keep the version reasonably current — an old Chrome version also triggers
  // Google's browser checks.
  sheetView.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/133.0.0.0 Safari/537.36'
  );

  // If Google's CEF detection triggers ("Sign in with a supported browser"),
  // the page navigates to accounts.google.com with a rejection indicator.
  // Intercept it and tell the renderer to show a recovery prompt instead of
  // leaving the user stranded on a Google error page.
  sheetView.webContents.on('did-navigate', (_event, url) => {
    if (/accounts\.google\.com.*(signin\/rejected|unsupported_browser|nomatch)/i.test(url)) {
      if (mainWindow) mainWindow.webContents.send('auth:cef-blocked');
    }
  });

  // Google Sheets registers a beforeunload handler that Electron surfaces as a
  // native dialog. Without this listener, navigating to a different spreadsheet
  // silently fails because the dialog is blocked and navigation is cancelled.
  sheetView.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault(); // bypass — Google Sheets auto-saves, dialog is unnecessary
  });

  // Suppress Google's "the app is better" / "get the app" promotional banners.
  // Google's compiled class names change frequently so CSS selectors are
  // unreliable. Instead we inject a MutationObserver that scans text content
  // and removes the element from the DOM entirely — bypassing the broken
  // dismiss handlers (which fire app-store URL navigations that fail silently
  // in Electron, leaving the dialog stuck open).
  const SUPPRESS_SCRIPT = `(function () {
    const PROMO_PHRASES = [
      'get the app', 'app is better', 'switch to app',
      'install the app', 'open in app', 'use the app',
      'try the app', 'sheets app',
      'chrome extension', 'install this google'
    ];

    function isPromo(el) {
      if (!el || typeof el.textContent !== 'string') return false;
      const t = el.textContent.toLowerCase();
      return PROMO_PHRASES.some(p => t.includes(p));
    }

    function sweep() {
      // Target fixed/sticky elements anywhere on the page — the banner is
      // always position:fixed at the bottom. Also check common ARIA roles.
      const candidates = document.querySelectorAll(
        'body > *, [role="dialog"], [role="banner"], ' +
        '[role="alertdialog"], [role="complementary"]'
      );
      candidates.forEach(el => {
        try {
          const s = window.getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'sticky') {
            if (isPromo(el)) { el.remove(); }
          }
        } catch (_) {}
      });
    }

    sweep();

    new MutationObserver(mutations => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1 && isPromo(node)) node.remove();
        });
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  })();`;

  sheetView.webContents.on('did-finish-load', () => {
    sheetView.webContents.executeJavaScript(SUPPRESS_SCRIPT).catch(() => {});
  });

  // Start blank — user opens a sheet via the toolbar URL bar or Drive launcher.
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Renderer tells main the panel opened or closed → resize the sheet view.
ipcMain.on('panel:toggle', (_e, isOpen) => {
  panelOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

// Renderer requests a panel toggle (e.g. from the toolbar button).
// Mirrors the Ctrl+K global shortcut logic.
ipcMain.on('panel:toggle-request', () => {
  panelOpen = !panelOpen;
  if (sheetView) sheetView.setBounds(sheetViewBounds());
  if (mainWindow) mainWindow.webContents.send('panel:toggle', panelOpen);
});

// Renderer asks main to load a sheet URL — bring the view on-screen.
ipcMain.on('sheet:open', (_e, url) => {
  const prevBase = currentSheetUrl.split('#')[0];
  const newBase  = url.split('#')[0];
  const newHash  = url.includes('#') ? url.split('#')[1] : null;

  currentSheetUrl = url;
  sheetActive     = true;

  if (sheetView) {
    sheetView.setBounds(sheetViewBounds());

    if (sheetActive && prevBase === newBase && newHash) {
      // Same spreadsheet already loaded — hash-only navigation (no network round-trip).
      // Safe because the Sheets client already knows every tab in this file.
      sheetView.webContents
        .executeJavaScript(`window.location.hash = '${newHash}'`)
        .catch(() => sheetView.webContents.loadURL(url)); // fallback if JS context unavailable
    } else {
      // Different spreadsheet, first open, or no hash — full load required.
      // Also handles first-time login: the Sheets page must load fresh so
      // Google's auth cookies are processed and the user lands in the right account.
      sheetView.webContents.loadURL(url);
    }
  }

  // Silently apply WRAP to all tabs once per session per spreadsheet.
  // Fixes existing sheets created before the WRAP-on-create change.
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = idMatch?.[1];
  if (spreadsheetId && oauth2Client && !wrappingFixedIds.has(spreadsheetId)) {
    wrappingFixedIds.add(spreadsheetId);
    fixSheetWrapping(oauth2Client, spreadsheetId)
      .catch(e => console.error('fixSheetWrapping:', e.message));
  }

  // Record in recents — fetch the sheet title from Drive, fall back to URL if unauthenticated.
  if (spreadsheetId) {
    (async () => {
      let name = 'untitled sheet';
      if (oauth2Client) {
        try { name = await getSheetTitle(oauth2Client, spreadsheetId); } catch {}
      }
      await addRecentSheet({ id: spreadsheetId, name, url });
    })();
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

// Renderer awaits this before rendering the toast strip, so the sheet bounds
// are guaranteed updated before the Svelte component becomes visible.
ipcMain.handle('toast:toggle', (_e, isVisible) => {
  toastVisible = Boolean(isVisible);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

// Renderer close button.
ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// ── Recent sheets ─────────────────────────────────────────────────────────────

ipcMain.handle('recent:get', () => getRecentSheets());
ipcMain.handle('recent:add', (_e, entry) => addRecentSheet(entry));

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
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    return await listFolder(oauth2Client, folderId);
  } catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:listSharedWithMe', async () => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    return await listSharedWithMe(oauth2Client);
  } catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:listSharedDrives', async () => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    return await listSharedDrives(oauth2Client);
  } catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:searchSheets', async (_e, query) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    return await searchSheets(oauth2Client, query);
  } catch (e) { throw friendlyError(e); }
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
  // Parse and cache each new tub immediately so it's ready when the panel opens.
  fs.mkdirSync(tubCacheDir(), { recursive: true });
  for (const tub of added) {
    try {
      const blocks = await parseTub(tub.filePath);
      fs.writeFileSync(tubCachePath(tub.id), JSON.stringify(blocks));
    } catch (e) {
      console.error(`tubs:add — failed to parse ${tub.name}:`, e.message);
    }
  }
  return added;
});

ipcMain.handle('tubs:remove', async (_e, id) => {
  const existing = await getTubs();
  await saveTubs(existing.filter(t => t.id !== id));
  // Clean up the JSON cache file.
  const cachePath = tubCachePath(id);
  if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
});

// ── Block parsing / injection handlers ───────────────────────────────────────

// Called at app startup: ensures every registered tub has a JSON cache so
// loading a tub in the panel is instant (no on-demand parse needed).
ipcMain.handle('tubs:parseAll', async () => {
  const tubs = await getTubs();
  fs.mkdirSync(tubCacheDir(), { recursive: true });
  const results = [];
  for (const tub of tubs) {
    try {
      const blocks = await ensureTubParsed(tub);
      results.push({ tubId: tub.id, name: tub.name, count: blocks.length });
    } catch (e) {
      results.push({ tubId: tub.id, name: tub.name, count: 0, error: e.message });
    }
  }
  return results;
});

// Return the cached block array for a single tub (parse on demand if missing).
ipcMain.handle('tubs:getBlocks', async (_e, tubId) => {
  const tubs = await getTubs();
  const tub  = tubs.find(t => t.id === tubId);
  if (!tub) throw new Error('Tub not found');
  return ensureTubParsed(tub);
});

// Write block content to the OS clipboard then simulate Ctrl+V into the sheet.
//
// Paste strategy: TSV quoting (RFC 4180).
// Google Sheets parses plain-text clipboard as tab-separated values. In TSV,
// wrapping a field in double-quotes lets it contain literal \n characters that
// become in-cell line breaks instead of new rows. Internal " are escaped as "".
//
// U+2028 was tried previously and silently stripped by Sheets — do not use it.
ipcMain.handle('blocks:inject', async (_e, content) => {
  // Normalise line endings then apply TSV quoting.
  const body    = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const escaped = body.replace(/"/g, '""');
  clipboard.writeText(`"${escaped}"`);
  if (sheetView) {
    sheetView.webContents.focus();
    sheetView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    sheetView.webContents.sendInputEvent({ type: 'keyUp',   keyCode: 'V', modifiers: ['control'] });
  }
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
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    return await createFlowSheet(oauth2Client, params);
  } catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:createFromTemplate', async (_e, params) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    return await createFlowFromTemplate(oauth2Client, params);
  } catch (e) { throw friendlyError(e); }
});

// On-demand WRAP fix — exposed to the renderer for the palette command.
ipcMain.handle('sheet:fixWrapping', async (_e, spreadsheetId) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    await fixSheetWrapping(oauth2Client, spreadsheetId);
    wrappingFixedIds.add(spreadsheetId);
  } catch (e) { throw friendlyError(e); }
});

// ── Sheet tab handler ─────────────────────────────────────────────────────────

ipcMain.handle('sheet:addTab', async (_e, { spreadsheetId, tabName, format }) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    const formatLinks    = await getFormatLinks();
    const copyFirstSheet = !!(formatLinks && formatLinks[format]);
    const result = await addFlowTab(oauth2Client, { spreadsheetId, tabName, format, copyFirstSheet });

    if (sheetView && currentSheetUrl) {
      // Google Sheets pushes new tab data to its running client via WebSocket
      // within ~1s of the API call. We wait 1400ms then use hash-only navigation
      // (no page reload, no loading screen). If the JS context is unavailable
      // we fall back to a full reload as a safety net.
      const base    = currentSheetUrl.split('#')[0];
      const gid     = result.sheetId;
      setTimeout(() => {
        if (!sheetView) return;
        sheetView.webContents
          .executeJavaScript(`window.location.hash = 'gid=${gid}'`)
          .catch(() => sheetView.webContents.loadURL(`${base}#gid=${gid}`));
      }, 1400);
    }
    return { ...result, usedTemplate: copyFirstSheet };
  } catch (e) {
    throw friendlyError(e);
  }
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

  // Ctrl+. / Cmd+. — open the panel (if closed) and focus the search input.
  // Lets the user click a cell in the sheet, hit Ctrl+., type a query, and
  // inject a block — without ever reaching for the mouse.
  //
  // Ctrl+. / Cmd+. — open the panel (if closed) and focus the search input.
  //
  // Focus sequencing matters: the WebContentsView (Google Sheets) owns OS focus
  // after injection. We must:
  //   1. mainWindow.focus()          — grab the OS-level BrowserWindow focus
  //   2. mainWindow.webContents.focus() — route keyboard to the Svelte renderer
  //   3. defer the IPC send ~50 ms   — give the OS time to process the focus
  //      transfer before element.focus() is called in the renderer.
  //      Without the delay, the renderer receives panel:focus-search while the
  //      WebContentsView still owns the keyboard, so element.focus() silently fails.
  globalShortcut.register('CommandOrControl+.', () => {
    if (!mainWindow) return;
    if (!panelOpen) {
      panelOpen = true;
      if (sheetView) sheetView.setBounds(sheetViewBounds());
      mainWindow.webContents.send('panel:toggle', panelOpen);
    }
    mainWindow.focus();
    mainWindow.webContents.focus();
    setTimeout(() => mainWindow.webContents.send('panel:focus-search'), 50);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});
