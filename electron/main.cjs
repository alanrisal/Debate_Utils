'use strict';

/**
 * main.cjs — FlowKit Electron Main Process
 *
 * HYBRID CHROME+ELECTRON ARCHITECTURE
 * ─────────────────────────────────────
 * FlowKit uses a two-layer approach to avoid Google's CEF (Chromium Embedded
 * Framework) detection that blocks sign-in in Electron WebContentsViews:
 *
 *   Layer 1 — Electron BrowserWindow (Svelte UI)
 *     The toolbar, launcher, and block panel live here.  These are always on
 *     top of the sheet area and receive all pointer / keyboard events for the
 *     FlowKit chrome.
 *
 *   Layer 2 — WebContentsView (Google Sheets renderer)
 *     The embedded sheet lives in a WebContentsView that is sized to fill
 *     the non-chrome area of the window.  UA spoofing + disabling Chromium's
 *     AutomationControlled feature flag make the view look like plain Chrome.
 *
 *   Auth bridge — chrome-bridge.cjs (CDP)
 *     On first launch (or after session expiry) we spawn real Chrome with a
 *     FlowKit-dedicated profile and a remote-debugging-port.  We use CDP's
 *     Network.getCookies to pull the user's Google session cookies from Chrome
 *     and inject them into the persist:flowkit-sheets Electron session via
 *     session.cookies.set().  After injection the WebContentsView already has
 *     a valid Google session and loads Sheets without any sign-in prompt.
 *
 *     The fragile OAuthLogin cookie-seeding hack has been removed.  It was
 *     calling accounts.google.com/accounts/OAuthLogin to convert an access_token
 *     into session cookies — an endpoint Google has been progressively restricting.
 *     The CDP approach uses real Chrome and is not subject to that restriction.
 *
 * BLOCK INJECTION
 * ────────────────
 *   Strategy A (edit mode): When a Sheets cell is in edit mode, Sheets
 *     creates a <div contenteditable="true"> element.  We try to inject
 *     directly via executeJavaScript + document.execCommand('insertText').
 *     Zero clipboard impact.
 *
 *   Strategy B (cell selected): Clipboard TSV + simulated Ctrl+V.  Google
 *     Sheets treats a double-quoted TSV field containing \n as in-cell line
 *     breaks, keeping long block content in a single cell.
 *
 * MULTI-USER COLLABORATION
 * ─────────────────────────
 *   Real-time collaboration works out-of-the-box because the sheet runs in
 *   Google's own infrastructure.  FlowKit only calls the Sheets/Drive REST API
 *   for metadata operations (create sheet, add tab, set formatting, get title).
 *   All live editing — including concurrent edits by multiple users — is handled
 *   by Google's WebSocket-based OT engine inside the embedded sheet.  We never
 *   read or write cell values through the API during an active session, so there
 *   is no risk of API quota exhaustion or write conflicts.
 */

const { app, BrowserWindow, ipcMain, globalShortcut,
        WebContentsView, dialog, clipboard } = require('electron');
const path       = require('path');
const fs         = require('fs');
const { randomUUID } = require('crypto');

// ── Environment ───────────────────────────────────────────────────────────────
// Load .env before anything that reads process.env.
// Packaged app: .env lives in process.resourcesPath (bundled via extraResources).
// Development: .env lives next to package.json (one level above electron/).
const ENV_PATHS = [
  path.join(process.resourcesPath ?? '', '.env'),
  path.join(__dirname, '../.env'),
];
for (const envPath of ENV_PATHS) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
    break;
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

// Chrome auth bridge — handles CDP-based cookie extraction from real Chrome.
// This replaces the fragile OAuthLogin cookie-seeding approach.
const { seedSession: chromeSeedSession, killChrome, findChrome } = require('./chrome-bridge.cjs');

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_WIDTH    = 300;  // px — matches BlockPanel.svelte width
const TOOLBAR_HEIGHT = 46;   // px — matches Toolbar.svelte height
const TOAST_HEIGHT   = 28;   // px — thin strip below toolbar for toasts

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow      = null;
let sheetView       = null;
let panelOpen       = false;
let launcherIsOpen  = false;
let paletteIsOpen   = false;
let sheetActive     = false;
let toastVisible    = false;
let oauth2Client    = null;
let currentUserInfo = null;
let currentSheetUrl = '';

// Tracks spreadsheetIds that have had WRAP applied this session.
const wrappingFixedIds = new Set();

// ── Tub cache ─────────────────────────────────────────────────────────────────

function tubCacheDir()        { return path.join(app.getPath('userData'), 'tub-cache'); }
function tubCachePath(tubId)  { return path.join(tubCacheDir(), `${tubId}.json`); }

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const clean = (e?.message || 'unexpected error').split('\n')[0].trim();
  return new Error(clean);
}

function sheetViewBounds() {
  const [w, h] = mainWindow.getContentSize();
  if (!sheetActive || launcherIsOpen || paletteIsOpen) {
    // Move the native WebContentsView completely off-screen whenever any Svelte
    // overlay needs to be visible and clickable (home screen, launcher, palette).
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

// ── Chrome auth bridge ────────────────────────────────────────────────────────
//
// Replaces the removed seedSheetViewSession() that used the OAuthLogin endpoint.
//
// initChromeAuth() is called:
//   1. At startup (initAuth) — silently, only succeeds if Chrome is already
//      running with CDP on our port (i.e. from a previous session).
//   2. After OAuth completes (auth:start handler) — not silent; will launch
//      Chrome and wait for sign-in if needed.
//   3. On-demand via 'auth:chrome-signin' IPC — user explicitly triggers it.
//
// The sheetView may not exist yet when initChromeAuth is called at startup.
// The caller must pass the session explicitly.

async function initChromeAuth(electronSession, { silent = false } = {}) {
  if (!electronSession) return;
  try {
    const result = await chromeSeedSession(electronSession, { silent });
    if (result.success) {
      console.log(`[main] Chrome auth bridge seeded ${result.injected} cookies (requiresSignIn=${result.requiresSignIn})`);
    } else if (result.error) {
      console.warn('[main] Chrome auth bridge did not seed session:', result.error);
    }
    return result;
  } catch (err) {
    console.error('[main] initChromeAuth failed:', err.message);
    return { success: false, injected: 0, requiresSignIn: false };
  }
}

// ── Auth bootstrap ────────────────────────────────────────────────────────────

async function initAuth() {
  const tokens = await getTokens();
  if (!tokens) return;

  try {
    const userInfo    = await getUserInfo();
    oauth2Client      = buildClientFromTokens(tokens);
    currentUserInfo   = userInfo;

    // Automatically persist refreshed tokens when googleapis rotates them.
    oauth2Client.on('tokens', async (newTokens) => {
      const existing = await getTokens();
      await setTokens({ ...existing, ...newTokens });
    });

    // sheetView is created inside createWindow() → attachSheetView(), which
    // runs after initAuth().  Wait for the window to open, then give the
    // WebContentsView a moment to attach before attempting cookie injection.
    app.once('browser-window-created', () => {
      setTimeout(async () => {
        if (!sheetView) return;
        // Silent mode: only succeeds if Chrome is already running on the CDP
        // port from a previous session.  This is a best-effort fast path.
        // Full auth (with Chrome launch) only runs when the user opens a sheet
        // and gets a CEF-blocked redirect, or when they explicitly sign in via
        // the auth:chrome-signin IPC handler.
        await initChromeAuth(sheetView.webContents.session, { silent: true });
      }, 1000);
    });
  } catch (err) {
    console.error('initAuth: failed to restore session', err);
    oauth2Client    = null;
    currentUserInfo = null;
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:    1400,
    height:   900,
    minWidth:  900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    attachSheetView();
  });

  mainWindow.on('resize', () => {
    if (sheetView) sheetView.setBounds(sheetViewBounds());
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    sheetView  = null;
  });
}

// ── WebContentsView (Google Sheets renderer) ──────────────────────────────────

function attachSheetView() {
  // 'persist:flowkit-sheets' gives the WebContentsView its own cookie/storage
  // partition that survives app restarts.  Real Google session cookies (injected
  // via the Chrome auth bridge) live in this partition, so the sheet loads
  // pre-authenticated on every subsequent launch.
  sheetView = new WebContentsView({
    webPreferences: {
      contextIsolation:     true,
      nodeIntegration:      false,
      partition:            'persist:flowkit-sheets',
      backgroundThrottling: false,
    },
  });

  mainWindow.contentView.addChildView(sheetView);
  sheetView.setBounds(sheetViewBounds());

  // Grant clipboard permissions so Google Sheets' Edit-menu copy/paste works
  // without the "install Chrome extension" prompt.
  sheetView.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  // UA spoofing — match the actual Chromium version Electron ships with.
  // process.versions.chrome is the real Chromium version string (e.g. "136.0.7103.48").
  // Using the actual version eliminates the version-mismatch fingerprint that
  // arose from the previously hardcoded '133.0.0.0'.
  const CHROME_VERSION = process.versions.chrome || '136.0.0.0';
  const platformUA = process.platform === 'win32'
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`
    : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
  sheetView.webContents.setUserAgent(platformUA);

  // Patch sec-ch-ua client hint headers so they match the spoofed UA above.
  // A mismatch between UA (claiming Chrome X) and sec-ch-ua (reporting
  // Chromium Y) is a reliable embedded-browser fingerprint.
  const majorVersion  = CHROME_VERSION.split('.')[0];
  const secChUa       = `"Not(A:Brand";v="99", "Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}"`;
  const secChPlatform = process.platform === 'win32' ? '"Windows"' : '"macOS"';

  sheetView.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://accounts.google.com/*', 'https://docs.google.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      headers['sec-ch-ua']          = secChUa;
      headers['sec-ch-ua-mobile']   = '?0';
      headers['sec-ch-ua-platform'] = secChPlatform;
      callback({ requestHeaders: headers });
    }
  );

  // CEF detection handler — when Google redirects to the "Sign in with a
  // supported browser" rejection page, we automatically attempt to recover
  // by running the Chrome auth bridge (which injects real Google cookies)
  // and then reloading the sheet.
  sheetView.webContents.on('did-navigate', async (_event, url) => {
    if (!/accounts\.google\.com.*(signin\/rejected|unsupported_browser|nomatch)/i.test(url)) return;

    console.log('[main] CEF block detected — attempting Chrome auth bridge recovery...');
    if (mainWindow) mainWindow.webContents.send('auth:cef-blocked');

    // Auto-recover: seed cookies from Chrome, then reload the sheet.
    const result = await initChromeAuth(sheetView.webContents.session, { silent: false });
    if (result?.success && sheetActive && currentSheetUrl) {
      sheetView.webContents.loadURL(currentSheetUrl);
      if (mainWindow) mainWindow.webContents.send('auth:chrome-complete', { injected: result.injected });
    }
  });

  // Google Sheets registers a beforeunload handler that Electron surfaces as a
  // native dialog.  Without this listener, navigating to a different spreadsheet
  // silently fails.  Sheets auto-saves, so bypassing the dialog is safe.
  sheetView.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  // Suppress Google's promotional banners ("Get the app", "Try the Chrome extension").
  // Uses a MutationObserver scanning text content rather than fragile compiled
  // class-name selectors, which change with every Google Sheets release.
  const SUPPRESS_SCRIPT = `(function () {
    const PHRASES = [
      'get the app','app is better','switch to app','install the app',
      'open in app','use the app','try the app','sheets app',
      'chrome extension','install this google'
    ];
    function isPromo(el) {
      if (!el || typeof el.textContent !== 'string') return false;
      const t = el.textContent.toLowerCase();
      return PHRASES.some(p => t.includes(p));
    }
    function sweep() {
      document.querySelectorAll(
        'body > *, [role="dialog"], [role="banner"], [role="alertdialog"], [role="complementary"]'
      ).forEach(el => {
        try {
          const s = window.getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'sticky') && isPromo(el)) el.remove();
        } catch (_) {}
      });
    }
    sweep();
    new MutationObserver(ms => {
      for (const m of ms) m.addedNodes.forEach(n => { if (n.nodeType === 1 && isPromo(n)) n.remove(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  })();`;

  sheetView.webContents.on('did-finish-load', () => {
    sheetView.webContents.executeJavaScript(SUPPRESS_SCRIPT).catch(() => {});
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on('panel:toggle', (_e, isOpen) => {
  panelOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

ipcMain.on('panel:toggle-request', () => {
  panelOpen = !panelOpen;
  if (sheetView) sheetView.setBounds(sheetViewBounds());
  if (mainWindow) mainWindow.webContents.send('panel:toggle', panelOpen);
});

ipcMain.on('sheet:open', (_e, url) => {
  const prevBase = currentSheetUrl.split('#')[0];
  const newBase  = url.split('#')[0];
  const newHash  = url.includes('#') ? url.split('#')[1] : null;

  currentSheetUrl = url;
  sheetActive     = true;

  if (sheetView) {
    sheetView.setBounds(sheetViewBounds());

    if (sheetActive && prevBase === newBase && newHash) {
      // Same spreadsheet — hash-only navigation; no network round-trip.
      sheetView.webContents
        .executeJavaScript(`window.location.hash = '${newHash}'`)
        .catch(() => sheetView.webContents.loadURL(url));
    } else {
      sheetView.webContents.loadURL(url);
    }
  }

  // Silently apply WRAP to all tabs once per session per spreadsheet.
  const idMatch       = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = idMatch?.[1];
  if (spreadsheetId && oauth2Client && !wrappingFixedIds.has(spreadsheetId)) {
    wrappingFixedIds.add(spreadsheetId);
    fixSheetWrapping(oauth2Client, spreadsheetId)
      .catch(e => console.error('fixSheetWrapping:', e.message));
  }

  // Record in recents.
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

ipcMain.on('home:show', () => {
  sheetActive = false;
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

ipcMain.on('launcher:toggle', (_e, isOpen) => {
  launcherIsOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

ipcMain.on('palette:toggle', (_e, isOpen) => {
  paletteIsOpen = Boolean(isOpen);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

ipcMain.handle('toast:toggle', (_e, isVisible) => {
  toastVisible = Boolean(isVisible);
  if (sheetView) sheetView.setBounds(sheetViewBounds());
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// ── Recent sheets ─────────────────────────────────────────────────────────────

ipcMain.handle('recent:get', () => getRecentSheets());
ipcMain.handle('recent:add', (_e, entry) => addRecentSheet(entry));

// ── Auth / Drive IPC ──────────────────────────────────────────────────────────

ipcMain.handle('auth:status', () => ({
  loggedIn:       !!oauth2Client,
  userInfo:       currentUserInfo,
  hasCredentials: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  chromeAvailable: !!findChrome(),
}));

ipcMain.handle('auth:start', async () => {
  const { tokens, userInfo, client } = await startAuthFlow();

  await setTokens(tokens);
  await setUserInfo(userInfo);

  oauth2Client    = client;
  currentUserInfo = userInfo;

  oauth2Client.on('tokens', async (newTokens) => {
    const existing = await getTokens();
    await setTokens({ ...existing, ...newTokens });
  });

  // Seed the WebContentsView session with real Google cookies from Chrome.
  // This replaces the removed OAuthLogin cookie-seeding hack.
  // If Chrome is not installed or the bridge fails, the user can still
  // sign in manually via the sheet view's own Google sign-in flow.
  if (sheetView) {
    const result = await initChromeAuth(sheetView.webContents.session, { silent: false });
    if (result?.success) {
      console.log('[main] auth:start — Chrome bridge succeeded, sheet view pre-authenticated');
    }
  }

  const authResult = { loggedIn: true, userInfo };

  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('auth:complete', authResult);
  }

  return authResult;
});

ipcMain.handle('auth:logout', async () => {
  await clearAll();
  oauth2Client    = null;
  currentUserInfo = null;
  return { loggedIn: false };
});

// On-demand Chrome auth bridge — called when:
//   • The renderer shows a "Sign in to Google Sheets" button
//   • The user wants to refresh a stale session
//   • The CEF block auto-recovery didn't succeed
ipcMain.handle('auth:chrome-signin', async () => {
  if (!sheetView) return { success: false, error: 'Sheet view not ready' };

  if (mainWindow) mainWindow.webContents.send('auth:chrome-signing-in');

  const result = await initChromeAuth(sheetView.webContents.session, { silent: false });

  if (result?.success && sheetActive && currentSheetUrl) {
    // Reload the current sheet so it picks up the freshly injected cookies.
    sheetView.webContents.loadURL(currentSheetUrl);
  }

  if (mainWindow) mainWindow.webContents.send('auth:chrome-complete', result);
  return result;
});

// ── Drive handlers ────────────────────────────────────────────────────────────

ipcMain.handle('drive:listFolder', async (_e, folderId) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try { return await listFolder(oauth2Client, folderId); }
  catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:listSharedWithMe', async () => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try { return await listSharedWithMe(oauth2Client); }
  catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:listSharedDrives', async () => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try { return await listSharedDrives(oauth2Client); }
  catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:searchSheets', async (_e, query) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try { return await searchSheets(oauth2Client, query); }
  catch (e) { throw friendlyError(e); }
});

// ── Template handlers ─────────────────────────────────────────────────────────

ipcMain.handle('templates:get', () => getTemplates());

ipcMain.handle('templates:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Select Template (.xlsx)',
    filters:    [{ name: 'Excel Files', extensions: ['xlsx'] }],
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

// ── Tubs handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('tubs:get', () => getTubs());

ipcMain.handle('tubs:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Select Block Files (.docx)',
    filters:    [{ name: 'Word Documents', extensions: ['docx'] }],
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
  const existing  = await getTubs();
  await saveTubs(existing.filter(t => t.id !== id));
  const cachePath = tubCachePath(id);
  if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
});

// ── Block parse/inject handlers ───────────────────────────────────────────────

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

ipcMain.handle('tubs:getBlocks', async (_e, tubId) => {
  const tubs = await getTubs();
  const tub  = tubs.find(t => t.id === tubId);
  if (!tub) throw new Error('Tub not found');
  return ensureTubParsed(tub);
});

/**
 * Block injection — two strategies:
 *
 * Strategy A — Direct JS injection (edit mode only)
 *   When a Sheets cell is in edit mode (user pressed F2 or double-clicked),
 *   Sheets creates a real <div contenteditable="true"> for text input.
 *   We try to insert the block text directly via document.execCommand.
 *   Zero clipboard impact, near-instant perceived latency.
 *
 * Strategy B — Clipboard TSV + simulated Ctrl+V (cell selected mode)
 *   Wrapping the content in TSV double-quotes tells Sheets to treat embedded
 *   newlines as in-cell line breaks rather than new rows.  Simulated Ctrl+V
 *   pastes into whichever cell the user last clicked — cell-position agnostic.
 */
ipcMain.handle('blocks:inject', async (_e, content) => {
  if (sheetView) {
    // Strategy A: JS injection into the contenteditable cell editor.
    // JSON.stringify ensures content with any characters is safely embedded.
    try {
      const injected = await sheetView.webContents.executeJavaScript(`
        (function (text) {
          // Google Sheets exposes a contenteditable div in edit mode.
          // We target it by role + contenteditable attribute — more stable than
          // compiled class names (which change with every Sheets release).
          const editor = document.querySelector(
            '[contenteditable="true"][role="textbox"], ' +
            '[contenteditable="true"].cell-input'
          );
          if (!editor) return false;
          // Only inject if the editor is actually the active element;
          // if focus has moved away, fall through to clipboard.
          if (document.activeElement !== editor) return false;
          editor.focus();
          return document.execCommand('insertText', false, ${JSON.stringify(content)});
        })(undefined)
      `);
      if (injected) return; // Successfully injected via JS — done.
    } catch { /* Sheet context unavailable or not in edit mode — fall through */ }
  }

  // Strategy B: clipboard TSV + simulated Ctrl+V.
  // RFC 4180 TSV quoting: wrap in double-quotes, escape internal quotes as "".
  // Google Sheets parses this as a single-cell value even when content has \n.
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

ipcMain.handle('formatLinks:get', () => getFormatLinks());

ipcMain.handle('formatLinks:set', async (_e, { format, templateId }) => {
  const links   = await getFormatLinks();
  const updated = { ...links, [format]: templateId ?? null };
  await saveFormatLinks(updated);
  return updated;
});

// ── Drive / Sheet creation handlers ──────────────────────────────────────────

ipcMain.handle('drive:createSheet', async (_e, params) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try { return await createFlowSheet(oauth2Client, params); }
  catch (e) { throw friendlyError(e); }
});

ipcMain.handle('drive:createFromTemplate', async (_e, params) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try { return await createFlowFromTemplate(oauth2Client, params); }
  catch (e) { throw friendlyError(e); }
});

ipcMain.handle('sheet:fixWrapping', async (_e, spreadsheetId) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    await fixSheetWrapping(oauth2Client, spreadsheetId);
    wrappingFixedIds.add(spreadsheetId);
  } catch (e) { throw friendlyError(e); }
});

ipcMain.handle('sheet:addTab', async (_e, { spreadsheetId, tabName, format }) => {
  if (!oauth2Client) throw new Error('not authenticated — please sign in again');
  try {
    const formatLinks    = await getFormatLinks();
    const copyFirstSheet = !!(formatLinks && formatLinks[format]);
    const result         = await addFlowTab(oauth2Client, { spreadsheetId, tabName, format, copyFirstSheet });

    if (sheetView && currentSheetUrl) {
      const base = currentSheetUrl.split('#')[0];
      const gid  = result.sheetId;
      // Google Sheets pushes the new tab to its running client via WebSocket
      // within ~1s.  We wait 1400ms then do hash-only navigation (no reload).
      setTimeout(() => {
        if (!sheetView) return;
        sheetView.webContents
          .executeJavaScript(`window.location.hash = 'gid=${gid}'`)
          .catch(() => sheetView.webContents.loadURL(`${base}#gid=${gid}`));
      }, 1400);
    }
    return { ...result, usedTemplate: copyFirstSheet };
  } catch (e) { throw friendlyError(e); }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

// These switches must be set before app.whenReady() fires.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Disabling AutomationControlled removes navigator.webdriver=true, which is
// Google's primary signal for detecting embedded/automated browsers.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.whenReady().then(async () => {
  await initAuth();
  createWindow();

  // Ctrl+K / Cmd+K — toggle the block panel.
  globalShortcut.register('CommandOrControl+K', () => {
    if (!mainWindow) return;
    panelOpen = !panelOpen;
    if (sheetView) sheetView.setBounds(sheetViewBounds());
    mainWindow.webContents.send('panel:toggle', panelOpen);
  });

  // Ctrl+. / Cmd+. — open the panel and focus the search input.
  // Lets the user click a cell, hit Ctrl+., type a query, and inject a block
  // without ever reaching for the mouse.
  //
  // Focus sequencing: WebContentsView owns OS focus after sheet interaction.
  //   1. mainWindow.focus()             — grab OS-level focus
  //   2. mainWindow.webContents.focus() — route keyboard to the Svelte renderer
  //   3. 50ms delay on the IPC send     — let the OS process the focus transfer
  //      before element.focus() is called in the renderer.
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
  killChrome(); // clean up any Chrome process launched by the auth bridge
  if (process.platform !== 'darwin') app.quit();
});
