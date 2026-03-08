/**
 * service-worker.js — FlowKit Chrome Extension Background Service Worker
 *
 * Replaces electron/main.cjs + electron/auth.cjs + electron/sheets-api.cjs.
 *
 * AUTH
 * ─────
 * Uses chrome.identity.getAuthToken() instead of the PKCE flow.
 * Chrome handles the OAuth consent UI natively — no redirect server, no
 * localhost callback, no fragile OAuthLogin cookie seeding.
 * The token is valid immediately and renews automatically.
 *
 * STORAGE
 * ────────
 * chrome.storage.local replaces electron-store throughout.
 * All keys mirror the existing store.cjs shape so component code is unchanged.
 *
 * DRIVE / SHEETS API
 * ───────────────────
 * All googleapis Node SDK calls are replaced with fetch() against the
 * Google REST endpoints. The service worker is a browser environment,
 * so fetch() is available natively.
 *
 * TUB PARSING
 * ────────────
 * mammoth.js (browser build) parses .docx ArrayBuffers sent from the sidebar.
 * DOMParser is available in Chrome Extension service workers (Chrome 93+).
 *
 * BLOCK INJECTION
 * ────────────────
 * The service worker forwards inject requests to the content script running
 * inside the active Google Sheets tab via chrome.tabs.sendMessage().
 */

import mammoth from 'mammoth';

// ── Active cell state ─────────────────────────────────────────────────────────
//
// Tracks the cell the user most recently selected in any open Sheets tab.
// Updated by CELL_SELECTED messages from content-script.js.
// Used by blocks:inject to write directly via the Sheets REST API.
//
// Service workers can be terminated and restarted by Chrome — this state
// resets on cold start. That's acceptable: the user just needs to click a cell
// once before injecting, which they would do naturally anyway.
let sheetState = {
  cell:          'A1',   // last known cell reference, e.g. "B3"
  sheet:         null,   // last known sheet tab name, e.g. "Neg" — may be null
  gid:           0,      // numeric sheetId for batchUpdate GridRange (from #gid= in URL)
  spreadsheetId: null,   // extracted from the Sheets tab URL
  tabId:         null,   // Chrome tab ID of the Sheets tab — used to send FOCUS_SHEET
};

// ── Cell highlight state ───────────────────────────────────────────────────────
//
// `highlighted`    — what is ACTUALLY bordered in the sheet right now.
//                    Includes the cell's originalBorders so we can restore
//                    them precisely when the selection moves away.
// `highlightLock`  — true while a batchUpdate call is in flight.
// `pendingTarget`  — the most recent desired target.
//                    Overwritten on each new request; processed after the
//                    in-flight call completes so rapid presses don't stack up.
// `highlightTimer` — debounce handle; collapses bursts of arrow keypresses
//                    into a single scheduleHighlight call.
let highlighted    = { cell: null, gid: null, spreadsheetId: null, sheet: null, originalBorders: null };
let highlightLock  = false;
let pendingTarget  = null;
let highlightTimer = null;



// Fetch the existing border formatting of a cell before we overwrite it so we
// can restore it exactly when the selection moves away.

// ── Highlight queue ────────────────────────────────────────────────────────────
//
// Queue a new target. If a batchUpdate is already running, store the target
// in pendingTarget and let the running call pick it up on completion.
// This guarantees at most one in-flight request at any time, and always uses
// the live value of `highlighted` when computing which cell to clear —
// eliminating the race where rapid navigation leaves stale borders.
async function scheduleHighlight(spreadsheetId, setCell, setGid, setSheet) {
  pendingTarget = { spreadsheetId, setCell, setGid, setSheet: setSheet ?? null };
  if (highlightLock) return;

  while (pendingTarget) {
    const target  = pendingTarget;
    pendingTarget = null;
    highlightLock = true;
    try {
      const token = await getToken(false);

      await applyHighlight(
        token,
        target.spreadsheetId,
        highlighted.cell,      // clear this cell
        highlighted.gid,
        null,                  // ← no originalBorders fetch — just clear to NONE
        target.setCell,        // highlight this cell
        target.setGid,
      );

      highlighted = {
        cell:            target.setCell,
        gid:             target.setGid,
        spreadsheetId:   target.spreadsheetId,
        sheet:           target.setSheet,
        originalBorders: null, // not tracking anymore
      };
    } catch (e) {
      console.warn('[sw] highlight failed:', e.message);
    } finally {
      highlightLock = false;
    }
  }
}

// Debounce helper — collapses rapid arrow-key presses into one scheduleHighlight call.
function triggerHighlight(spreadsheetId, cell, gid, sheet) {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => scheduleHighlight(spreadsheetId, cell, gid, sheet), 150);
}

// ── Cell-reference helpers ─────────────────────────────────────────────────────

// Convert a column letter string (A, B, Z, AA, AB …) to a 0-based index.
function colToIndex(col) {
  let n = 0;
  for (const c of col.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

// Parse an A1-notation cell reference into a batchUpdate GridRange object.
// Handles single cells (B3) and ranges (B3:C5). Returns null on bad input.
function cellToGridRange(cellRef, sheetId) {
  const m = cellRef.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return null;
  const [, c1, r1, c2, r2] = m;
  return {
    sheetId,
    startRowIndex:    parseInt(r1, 10) - 1,
    endRowIndex:      parseInt(r2 ?? r1, 10),
    startColumnIndex: colToIndex(c1),
    endColumnIndex:   colToIndex(c2 ?? c1) + 1,
  };
}

// ── Highlight API call ─────────────────────────────────────────────────────────

// Border style applied to the target cell while it is selected.
// Uses a solid medium blue border so the highlight is template-color-agnostic
// and doesn't modify the cell's background fill.
const HIGHLIGHT_BORDER = { style: 'SOLID_MEDIUM', color: { red: 0.231, green: 0.510, blue: 0.965 } };
const CLEAR_BORDER     = { style: 'SOLID', 
  color: { red: 0.851, green: 0.851, blue: 0.851 }};

// Apply (or clear) cell border highlights via a single batchUpdate call.
// clearCell/clearGid/clearBorders → the previously highlighted cell to restore (may be null)
// setCell/setGid                  → the new cell to border (may be null to just clear)
async function applyHighlight(token, spreadsheetId, clearCell, clearGid, clearBorders, setCell, setGid) {
  const requests = [];

  // Restore the old cell's original borders exactly. If the cell had no borders
  // originally, explicitly set all sides to NONE to remove our highlight cleanly.
  if (clearCell && clearGid != null) {
    const range = cellToGridRange(clearCell, clearGid);
    
    if (range) {
      const borders = clearBorders ?? {
        top: CLEAR_BORDER, bottom: CLEAR_BORDER, left: CLEAR_BORDER, right: CLEAR_BORDER,
      };
      requests.push({
        repeatCell: {
          range,
          cell:   { userEnteredFormat: { borders } },
          fields: 'userEnteredFormat.borders',
        },
      });
    }
  }

  // Add a blue border to the new target cell.
  if (setCell && setGid != null) {
    const range = cellToGridRange(setCell, setGid);
    if (range) {
      requests.push({
        repeatCell: {
          range,
          cell:   { userEnteredFormat: { borders: { top: HIGHLIGHT_BORDER, bottom: HIGHLIGHT_BORDER, left: HIGHLIGHT_BORDER, right: HIGHLIGHT_BORDER } } },
          fields: 'userEnteredFormat.borders',
        },
      });
    }
  }

  if (!requests.length) return;

  await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body:   JSON.stringify({ requests }),
  });
}

// ── Side panel setup ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // Open the side panel when the user clicks the toolbar action icon.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Inject the content script into any Google Sheets tabs that were already
  // open before the extension installed or reloaded. Chrome only auto-injects
  // content scripts into tabs that open AFTER the extension is active — existing
  // tabs keep their old (or absent) content script until manually refreshed.
  // chrome.scripting.executeScript with files: ['content-script.js'] re-injects
  // the current build into those tabs so sendMessage works immediately.
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/spreadsheets/*' });
  for (const tab of tabs) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['content-script.js'],
    }).catch(() => {
      // Tab may be in a state where injection is not allowed (e.g. chrome:// pages,
      // discarded tabs). Ignore — the user can refresh those tabs manually.
    });
  }
});

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Returns a valid access token using chrome.identity.
 * Interactive=true shows the Google sign-in UI if no token is cached.
 * Chrome handles token refresh automatically.
 */
async function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function getUserInfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`userinfo ${res.status}`);
  return res.json();
}

async function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

// ── Storage helpers (mirrors store.cjs) ──────────────────────────────────────

const storage = {
  async get(key, fallback = null) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? fallback;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

// ── Google API fetch wrappers ─────────────────────────────────────────────────

async function gFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google API ${res.status}: ${text}`);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ── Drive API ─────────────────────────────────────────────────────────────────

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME  = 'application/vnd.google-apps.spreadsheet';
const EXCEL_MIME  = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

const SHEET_FILTER = `(mimeType='${SHEET_MIME}' or mimeType='${EXCEL_MIME}')`;

async function driveListFolder(token, folderId) {
  const q = encodeURIComponent(
    `'${folderId}' in parents and (mimeType='${FOLDER_MIME}' or ${SHEET_FILTER}) and trashed=false`
  );
  const data = await gFetch(token,
    `${DRIVE_BASE}/files?q=${q}&orderBy=folder,name&pageSize=200` +
    `&fields=files(id,name,mimeType,modifiedTime,webViewLink)` +
    `&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`
  );
  return data.files || [];
}

async function driveListSharedWithMe(token) {
  const q = encodeURIComponent(`sharedWithMe and ${SHEET_FILTER} and trashed=false`);
  const data = await gFetch(token,
    `${DRIVE_BASE}/files?q=${q}&orderBy=modifiedTime+desc&pageSize=200` +
    `&fields=files(id,name,mimeType,modifiedTime,webViewLink)` +
    `&includeItemsFromAllDrives=true&supportsAllDrives=true`
  );
  return data.files || [];
}

async function driveListSharedDrives(token) {
  const data = await gFetch(token, `${DRIVE_BASE}/drives?pageSize=50&fields=drives(id,name)`);
  return data.drives || [];
}

async function driveSearchSheets(token, query) {
  const q = encodeURIComponent(
    `name contains '${query.replace(/'/g, "\\'")}' and ${SHEET_FILTER} and trashed=false`
  );
  const data = await gFetch(token,
    `${DRIVE_BASE}/files?q=${q}&orderBy=modifiedTime+desc&pageSize=50` +
    `&fields=files(id,name,mimeType,modifiedTime,webViewLink)` +
    `&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`
  );
  return data.files || [];
}

async function driveGetTitle(token, fileId) {
  const data = await gFetch(token,
    `${DRIVE_BASE}/files/${fileId}?fields=name&supportsAllDrives=true`
  );
  return data.name || 'untitled sheet';
}

// ── Format headers ────────────────────────────────────────────────────────────

const FORMAT_HEADERS = {
  Policy: ['1AC', 'CX', '2NC', 'CX', '1AR', '2NR', '2AR'],
  LD:     ['AC', 'CX', 'NC', 'CX', '1AR', 'NR', '2AR'],
  PF:     ['Pro Case', 'Con Case', 'Rebuttal', 'Summary', 'FF'],
};

function makeFormatRequests(sheetId, headers) {
  return [
    // Bold header row
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    // Freeze header row
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Column widths: 160px each
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: headers.length },
        properties: { pixelSize: 160 },
        fields: 'pixelSize',
      },
    },
    // Text wrap on data rows
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat.wrapStrategy',
      },
    },
  ];
}

// ── Sheets API ────────────────────────────────────────────────────────────────

async function createFlowSheet(token, { name, folderId, format }) {
  // 1. Create the file in Drive
  const file = await gFetch(token,
    `${DRIVE_BASE}/files?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: 'POST',
      body: JSON.stringify({ name, mimeType: SHEET_MIME, parents: [folderId] }),
    }
  );
  const spreadsheetId = file.id;

  // 2. Get the default sheet's sheetId
  const ss = await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
  const sheetId = ss.sheets[0].properties.sheetId;

  // 3. Write headers
  const headers = FORMAT_HEADERS[format] || FORMAT_HEADERS.Policy;
  await gFetch(token,
    `${SHEETS_BASE}/${spreadsheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [headers] }) }
  );

  // 4. Format: bold, freeze, column width, wrap
  await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: makeFormatRequests(sheetId, headers) }),
  });

  return { id: file.id, name: file.name, webViewLink: file.webViewLink };
}

async function createFlowFromTemplate(token, { name, folderId, fileData }) {
  // fileData is a Uint8Array-like array from the sidebar file picker.
  const boundary = `flowkit_${Date.now()}`;
  const metadata = JSON.stringify({ name, mimeType: SHEET_MIME, parents: [folderId] });
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const filePart = `--${boundary}\r\nContent-Type: ${EXCEL_MIME}\r\n\r\n`;
  const tail     = `\r\n--${boundary}--`;

  const body = new Blob([metaPart, filePart, new Uint8Array(fileData), tail]);

  const res = await fetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
  const file = await res.json();
  return { id: file.id, name: file.name, webViewLink: file.webViewLink };
}

async function addFlowTab(token, { spreadsheetId, tabName, format }) {
  // 1. Add the sheet tab
  const addRes = await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: tabName } } }],
    }),
  });
  const newSheet = addRes.replies[0].addSheet.properties;
  const sheetId  = newSheet.sheetId;

  // 2. Write headers
  const headers = FORMAT_HEADERS[format] || FORMAT_HEADERS.Policy;
  await gFetch(token,
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [headers] }) }
  );

  // 3. Format
  await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: makeFormatRequests(sheetId, headers) }),
  });

  return { sheetId, title: newSheet.title };
}

async function fixSheetWrapping(token, spreadsheetId) {
  const ss = await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
  const requests = ss.sheets.map(s => ({
    repeatCell: {
      range: { sheetId: s.properties.sheetId, startRowIndex: 1 },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat.wrapStrategy',
    },
  }));
  await gFetch(token, `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

// ── .docx parsing (mammoth, browser build) ────────────────────────────────────
//
// DOMParser is available in Chrome Extension service workers (Chrome 93+).
// The sidebar sends file bytes as a plain array; we reconstruct an ArrayBuffer here.

function parseTubFromHtml(html, tubId) {
  // Pure-regex parser — avoids DOMParser which is unavailable in MV3 service workers.
  const blocks = [];
  let pocket = '', hat = '', block = '', lines = [];

  function flush() {
    if (block && lines.length) {
      blocks.push({
        id:      `${tubId}-${blocks.length}`,
        pocket,
        hat,
        block,
        content: lines.join('\n').trim(),
      });
    }
    lines = [];
  }

  // Strip inner tags and decode common HTML entities.
  function plain(s) {
    return s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .trim();
  }

  // Match block-level elements in document order.
  // mammoth outputs clean, non-nested block HTML so this regex is reliable.
  const re = /<(h[1-4]|p)(?:\s[^>]*)?>([^]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag  = m[1].toLowerCase();
    const text = plain(m[2]);
    if (!text) continue;

    if      (tag === 'h1')                    { flush(); pocket = text; hat = ''; block = ''; }
    else if (tag === 'h2')                    { flush(); hat = text; block = ''; }
    else if (tag === 'h3' || tag === 'h4')   { flush(); block = text; }
    else if (tag === 'p')                     { lines.push(text); }
  }
  flush();
  return blocks;
}

async function parseTub(arrayBuffer, tubId) {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  return parseTubFromHtml(html, tubId);
}

// ── Tub cache (chrome.storage.local) ─────────────────────────────────────────

const TUB_CACHE_PREFIX = 'tub_cache_';

async function getCachedBlocks(tubId) {
  return storage.get(TUB_CACHE_PREFIX + tubId, null);
}

async function setCachedBlocks(tubId, blocks) {
  await storage.set(TUB_CACHE_PREFIX + tubId, blocks);
}

async function clearCachedBlocks(tubId) {
  await storage.remove(TUB_CACHE_PREFIX + tubId);
}

// ── Recent sheets ─────────────────────────────────────────────────────────────

async function addRecentSheet({ id, name, url }) {
  let recents = await storage.get('recentSheets', []);
  recents = recents.filter(r => r.id !== id);
  recents.unshift({ id, name, url, openedAt: new Date().toISOString() });
  if (recents.length > 10) recents = recents.slice(0, 10);
  await storage.set('recentSheets', recents);
}

// ── Error normaliser ──────────────────────────────────────────────────────────

function friendlyError(e) {
  const raw = (e?.message || '').toLowerCase();
  if (raw.includes('not authenticated') || raw.includes('token')) return 'not authenticated — please sign in again';
  if (raw.includes('403') || raw.includes('forbidden'))    return 'permission denied — you may not have edit access';
  if (raw.includes('404') || raw.includes('not found'))    return 'document not found — it may have been deleted';
  if (raw.includes('429') || raw.includes('quota'))        return 'google api rate limit — try again in a moment';
  if (raw.includes('network') || raw.includes('failed to fetch')) return 'network error — check your connection';
  return e?.message?.split('\n')[0] || 'unexpected error';
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    data  => sendResponse({ data }),
    error => sendResponse({ error: friendlyError(error) })
  );
  return true; // keep channel open for async response
});

async function handle(msg, sender = {}) {
  const { type } = msg;

  // ── Auth ────────────────────────────────────────────────────────────────────

  if (type === 'auth:status') {
    const cached = await storage.get('userInfo', null);
    let loggedIn = false;
    if (cached) {
      try {
        await getToken(false); // non-interactive: checks cached token
        loggedIn = true;
      } catch { /* token expired or not signed in */ }
    }
    return { loggedIn, userInfo: cached, hasCredentials: true };
  }

  if (type === 'auth:start') {
    const token   = await getToken(true); // interactive: shows consent UI
    const info    = await getUserInfo(token);
    await storage.set('userInfo', info);
    return { loggedIn: true, userInfo: info };
  }

  if (type === 'auth:logout') {
    const token = await getToken(false).catch(() => null);
    if (token) await removeCachedToken(token);
    await storage.remove('userInfo');
    return { loggedIn: false };
  }

  // ── Drive ───────────────────────────────────────────────────────────────────

  if (type === 'drive:listFolder') {
    const token = await getToken(false);
    return driveListFolder(token, msg.folderId);
  }

  if (type === 'drive:listSharedWithMe') {
    const token = await getToken(false);
    return driveListSharedWithMe(token);
  }

  if (type === 'drive:listSharedDrives') {
    const token = await getToken(false);
    return driveListSharedDrives(token);
  }

  if (type === 'drive:searchSheets') {
    const token = await getToken(false);
    return driveSearchSheets(token, msg.query);
  }

  // ── Sheet creation ──────────────────────────────────────────────────────────

  if (type === 'drive:createSheet') {
    const token = await getToken(false);
    return createFlowSheet(token, msg);
  }

  if (type === 'drive:createFromTemplate') {
    const token = await getToken(false);
    return createFlowFromTemplate(token, msg);
  }

  // ── Sheet mutation ──────────────────────────────────────────────────────────

  if (type === 'sheet:addTab') {
    const token  = await getToken(false);
    const result = await addFlowTab(token, msg);
    return result;
  }

  if (type === 'sheet:fixWrapping') {
    const token = await getToken(false);
    await fixSheetWrapping(token, msg.spreadsheetId);
    return null;
  }

  if (type === 'sheet:getTitle') {
    const token = await getToken(false);
    return driveGetTitle(token, msg.spreadsheetId);
  }

  // ── Recent sheets ────────────────────────────────────────────────────────────

  if (type === 'recent:get')  return storage.get('recentSheets', []);
  if (type === 'recent:add')  { await addRecentSheet(msg); return null; }

  // ── Templates ───────────────────────────────────────────────────────────────

  if (type === 'templates:get') return storage.get('userTemplates', []);

  if (type === 'templates:add') {
    // fileData and fileName are sent from the sidebar's file picker
    const id      = crypto.randomUUID();
    const tmpl    = { id, name: msg.name, fileData: msg.fileData };
    const existing = await storage.get('userTemplates', []);
    await storage.set('userTemplates', [...existing, tmpl]);
    return tmpl;
  }

  if (type === 'templates:remove') {
    const existing = await storage.get('userTemplates', []);
    await storage.set('userTemplates', existing.filter(t => t.id !== msg.id));
    return null;
  }

  // ── Format links ─────────────────────────────────────────────────────────────

  if (type === 'formatLinks:get') return storage.get('formatLinks', { Policy: null, LD: null, PF: null });

  if (type === 'formatLinks:set') {
    const links   = await storage.get('formatLinks', { Policy: null, LD: null, PF: null });
    const updated = { ...links, [msg.format]: msg.templateId ?? null };
    await storage.set('formatLinks', updated);
    return updated;
  }

  // ── Tubs ─────────────────────────────────────────────────────────────────────

  if (type === 'tubs:get') return storage.get('tubs', []);

  if (type === 'tubs:add') {
    // msg.fileData = Array<number> (Uint8Array serialized), msg.fileName = string
    const id       = crypto.randomUUID();
    const name     = msg.fileName.replace(/\.docx$/i, '');
    const tub      = { id, name, fileName: msg.fileName };
    const existing = await storage.get('tubs', []);
    await storage.set('tubs', [...existing, tub]);

    // Parse and cache immediately so the panel loads instantly
    try {
      const ab     = new Uint8Array(msg.fileData).buffer;
      const blocks = await parseTub(ab, id);
      await setCachedBlocks(id, blocks);
    } catch (e) {
      console.error('[sw] tubs:add parse failed:', e.message);
    }

    return tub;
  }

  if (type === 'tubs:remove') {
    const existing = await storage.get('tubs', []);
    await storage.set('tubs', existing.filter(t => t.id !== msg.id));
    await clearCachedBlocks(msg.id);
    return null;
  }

  if (type === 'tubs:getBlocks') {
    const cached = await getCachedBlocks(msg.tubId);
    if (cached) return cached;
    throw new Error('Tub not cached — re-add the file to reload it');
  }

  if (type === 'tubs:parseAll') {
    // Re-parse any tubs that are missing from the cache.
    // Note: in the extension we don't have the original file bytes after the
    // initial add (chrome.storage doesn't persist ArrayBuffers efficiently).
    // This is a no-op for now — parsing happens at add time and results are cached.
    const tubs = await storage.get('tubs', []);
    const results = [];
    for (const tub of tubs) {
      const cached = await getCachedBlocks(tub.id);
      results.push({ tubId: tub.id, name: tub.name, count: cached?.length ?? 0 });
    }
    return results;
  }

  // ── Cell tracking (from content-script.js) ───────────────────────────────────
  // The content script sends this whenever the user clicks or navigates to a
  // new cell. We store it so blocks:inject always knows where to write.

  if (type === 'CELL_SELECTED') {
    const idMatch  = msg.url?.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const prevCell = sheetState.cell;
    const prevGid  = sheetState.gid;
    

    sheetState = {
      cell:          msg.cell         || sheetState.cell,
      sheet:         msg.sheet        || null,
      gid:           msg.gid          ?? sheetState.gid,
      spreadsheetId: idMatch ? idMatch[1] : sheetState.spreadsheetId,
      tabId:         sender.tab?.id   ?? sheetState.tabId,
    };

    if (sheetState.spreadsheetId) {
      triggerHighlight(
        sheetState.spreadsheetId,
        sheetState.cell,
        sheetState.gid,
        sheetState.sheet
      );
    }

    return null;
  }

  // ── Ctrl+. shortcut forwarding ────────────────────────────────────────────────
  if (type === 'FOCUS_SEARCH') return null;

  // ── Sidebar arrow-key cell navigation ─────────────────────────────────────────
  // BlockPanel sends this when the user presses an arrow key with no search query.
  // Update sheetState to the new cell and fire the debounced highlight update —
  // same path as CELL_SELECTED but driven from the sidebar instead of the sheet.
  if (type === 'cell:setTarget') {
    const prevCell = sheetState.cell;
    const prevGid  = sheetState.gid;

    if (msg.cell           != null) sheetState.cell          = msg.cell;
    if (msg.gid            != null) sheetState.gid           = msg.gid;
    if (msg.spreadsheetId  != null) sheetState.spreadsheetId = msg.spreadsheetId;

    if (sheetState.spreadsheetId) {
      triggerHighlight(
        sheetState.spreadsheetId,
        sheetState.cell,
        sheetState.gid,
        sheetState.sheet
      );
    }
    return null;
  }

  // ── Block injection via Sheets REST API ───────────────────────────────────────
  // Google Sheets renders on <canvas> — execCommand and synthetic keyboard events
  // are both blocked. The only reliable write path is the Sheets REST API.
  //
  // The content script has been tracking the user's active cell via CELL_SELECTED
  // messages, so sheetState always holds a fresh cell reference.

  if (type === 'blocks:inject') {
    if (!sheetState.spreadsheetId) {
      throw new Error('click a cell in your Google Sheet first, then try again');
    }

    const token = await getToken(false);

    // Build the A1 notation range. If we know the sheet tab name, prefix it
    // so the write lands on the correct tab in multi-tab flows (e.g. "Neg!B3").
    // Sheet names containing spaces or special characters MUST be wrapped in
    // single quotes (e.g. "'Neg Flow'!B3") — the Sheets API returns 400 otherwise.
    // Any literal single quotes inside the name are escaped by doubling them.
    // Without a prefix the API defaults to the first sheet in the spreadsheet.
    let range;
    if (sheetState.sheet) {
      const escaped = sheetState.sheet.replace(/'/g, "''");
      range = `'${escaped}'!${sheetState.cell}`;
    } else {
      range = sheetState.cell;
    }

    // Write block content as a single cell value using RAW input so special
    // characters (=, +, -) are not interpreted as formulas.
    await gFetch(token,
      `${SHEETS_BASE}/${sheetState.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [[msg.content]] }) }
    );

    // After the write lands, tell the content script to reclaim window focus.
    if (sheetState.tabId) {
      chrome.tabs.sendMessage(sheetState.tabId, { type: 'FOCUS_SHEET' }).catch(() => {});
    }

    // Clear the highlight. Cancel any pending debounce first so a queued
    // navigation update doesn't re-color the cell right after we clear it.


    clearTimeout(highlightTimer);
    if (highlighted.spreadsheetId) {
      scheduleHighlight(highlighted.spreadsheetId, null, null, null).catch(() => {});
    }

    return { ok: true, cell: range };
  }

  throw new Error(`Unknown message type: ${type}`);
}
