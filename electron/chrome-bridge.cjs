'use strict';

/**
 * chrome-bridge.cjs — Hybrid Chrome/Electron Auth Bridge
 *
 * WHY THIS EXISTS
 * ────────────────
 * Google detects Electron's WebContentsView as an embedded browser (CEF) and
 * blocks sign-in with "This browser or app may not be secure." The detection
 * works on multiple signals: navigator.webdriver, Electron UA strings,
 * sec-ch-ua client hints, and the presence of the OAuthLogin cookie-seeding
 * endpoint (which Google has progressively restricted).
 *
 * THE HYBRID APPROACH
 * ────────────────────
 * Real Chrome (the user's installed browser) is never blocked — Google
 * controls Chrome and treats it as trusted. We exploit this by:
 *
 *   1. Launching Chrome with a FlowKit-dedicated user-data-dir and a
 *      remote-debugging-port (Chrome DevTools Protocol / CDP).
 *   2. Letting the user sign in once in that Chrome window.
 *      Google's full auth flow runs in real Chrome — no blocks.
 *   3. Extracting all google.com session cookies from Chrome via CDP's
 *      Network.getCookies command.
 *   4. Injecting those cookies into Electron's persist:flowkit-sheets
 *      session partition via session.cookies.set().
 *
 * After step 4 the WebContentsView already has valid Google session cookies
 * and loads Google Sheets without triggering any sign-in flow at all.
 * On every subsequent launch the FlowKit Chrome profile retains the cookies,
 * so steps 1–3 complete silently in seconds with no user interaction.
 *
 * BLOCK INJECTION
 * ────────────────
 * The main grid of Google Sheets is drawn on a <canvas> element — there is
 * no DOM to manipulate. HOWEVER, when a cell enters edit mode (double-click
 * or F2), Sheets creates a real <div contenteditable="true"> for text input.
 *
 * inject() therefore attempts a two-strategy approach:
 *   Strategy A: executeJavaScript into the Sheets page to find the
 *               contenteditable editor and call document.execCommand('insertText').
 *               Zero clipboard impact, works instantly in edit mode.
 *   Strategy B: Clipboard + sendInputEvent Ctrl+V. Works regardless of edit
 *               mode — Sheets interprets a paste on a selected (non-editing)
 *               cell as a cell-value write. TSV quoting keeps content in one
 *               cell even when it contains newlines.
 *
 * REQUIREMENTS
 * ─────────────
 * - Node 22 / Electron 40: uses globalThis.WebSocket (stable since Node 22)
 * - No additional npm packages required
 * - Google Chrome or Microsoft Edge must be installed on the machine
 */

const { spawn }    = require('child_process');
const http         = require('http');
const path         = require('path');
const fs           = require('fs');
const { app, clipboard } = require('electron');

// ── Constants ────────────────────────────────────────────────────────────────

// Use a port that doesn't conflict with the user's own Chrome sessions (9222).
const CDP_PORT = 19222;

// Google domains we need cookies for.
const GOOGLE_URLS = [
  'https://accounts.google.com',
  'https://docs.google.com',
  'https://drive.google.com',
  'https://sheets.googleapis.com',
  'https://www.google.com',
];

// Regex that matches the main Google session auth cookie.
// If this cookie is present, the Google session is active.
const SESSION_COOKIE_RE = /^(SID|__Secure-1PSID|__Secure-3PSID)$/;

// ── Chrome executable discovery ───────────────────────────────────────────────

/**
 * Returns the path to the Chrome (or Edge) executable on this machine,
 * or null if neither is installed.
 */
function findChrome() {
  if (process.platform === 'win32') {
    const bases = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);

    for (const base of bases) {
      const chrome = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (fs.existsSync(chrome)) return chrome;
    }
    // Edge uses the same Chromium/CDP stack and works identically.
    for (const base of bases) {
      const edge = path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (fs.existsSync(edge)) return edge;
    }
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    // Linux — probe common binary names via which(1)
    const { execSync } = require('child_process');
    for (const cmd of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge-stable']) {
      try {
        const p = execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim();
        if (p) return p;
      } catch { /* not found, try next */ }
    }
  }
  return null;
}

// ── FlowKit Chrome profile ───────────────────────────────────────────────────

/**
 * FlowKit stores its own Chrome profile here (separate from the user's main
 * Chrome profile). This lets us launch Chrome for auth even when the user's
 * Chrome is already open, and avoids touching the user's browsing data.
 */
function getFlowKitChromeProfile() {
  return path.join(app.getPath('userData'), 'chrome-auth-profile');
}

// ── Chrome process management ─────────────────────────────────────────────────

let _chromeProc = null;

/**
 * Spawns Chrome with the FlowKit profile and CDP enabled.
 * Opens a small sign-in window pointing to Google Accounts.
 * Chrome runs in --app mode (no browser chrome UI) so it looks
 * like a purposeful FlowKit auth dialog, not a random browser window.
 */
function launchChrome(chromePath) {
  const profileDir = getFlowKitChromeProfile();
  fs.mkdirSync(profileDir, { recursive: true });

  _chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-extensions',
    // --app opens a focused sign-in window without a full browser UI.
    // The continue= param redirects to Drive after sign-in so the user
    // sees a familiar destination (not a blank page).
    '--app=https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fdrive.google.com',
    '--window-size=480,660',
  ], {
    detached: true,
    stdio:    'ignore',
  });

  // Allow Electron to exit without waiting for this Chrome process.
  _chromeProc.unref();
  return _chromeProc;
}

function killChrome() {
  if (_chromeProc && !_chromeProc.killed) {
    try { _chromeProc.kill(); } catch { /* ignore */ }
    _chromeProc = null;
  }
}

// ── Minimal CDP client ────────────────────────────────────────────────────────
//
// We implement a minimal CDP client using:
//   - Node's built-in http module (for /json/version polling)
//   - globalThis.WebSocket (native in Node 22 / Electron 40, no npm packages)
//
// The client is intentionally narrow: we only need Network.getCookies.

function httpJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('http timeout')); });
  });
}

/**
 * Polls Chrome's CDP HTTP endpoint until it responds, then returns the
 * browser-level WebSocket debugger URL.
 *
 * Chrome's CDP port is open within ~1–3 seconds of process start.
 * We poll every 300ms for up to timeoutMs.
 */
async function waitForCDPReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await httpJson(`http://localhost:${port}/json/version`, 1500);
      if (info?.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch { /* Chrome not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`);
}

/**
 * Opens a CDP WebSocket session, runs a sequence of commands, returns results.
 *
 * Uses globalThis.WebSocket (Node 22+ native, available in Electron 40).
 * No external ws package required.
 *
 * @param {string} wsUrl - Browser-level debugger WebSocket URL
 * @param {Array<{method: string, params?: object}>} commands - CDP commands to run in order
 * @returns {Promise<any[]>} - Array of result objects, one per command
 */
async function runCDP(wsUrl, commands) {
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('globalThis.WebSocket not available — requires Node 22 / Electron 40+');

  return new Promise((resolve, reject) => {
    const ws      = new WS(wsUrl);
    let   msgId   = 0;
    const pending = new Map();
    const results = [];

    ws.onopen = async () => {
      try {
        for (const { method, params } of commands) {
          const id = ++msgId;
          const result = await new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method}`));
            }, 8000);
            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
          results.push(result);
        }
        ws.close();
        resolve(results);
      } catch (e) {
        ws.close();
        reject(e);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { res, rej, timer } = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      } catch { /* malformed CDP frame, ignore */ }
    };

    ws.onerror = () => reject(new Error('CDP WebSocket error'));

    // Hard overall timeout — prevents a hung connection from blocking the app.
    setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) ws.close();
      reject(new Error('CDP session overall timeout'));
    }, 45000);
  });
}

// ── Cookie extraction and injection ──────────────────────────────────────────

/**
 * Extracts all google.com cookies from the Chrome instance running on CDP_PORT.
 * Returns the raw CDP cookie objects.
 */
async function extractCookies(port) {
  const wsUrl = await waitForCDPReady(port, 5000);
  const [, cookiesResult] = await runCDP(wsUrl, [
    { method: 'Network.enable' },
    { method: 'Network.getCookies', params: { urls: GOOGLE_URLS } },
  ]);
  return cookiesResult?.cookies ?? [];
}

/**
 * Injects an array of CDP-format cookies into an Electron session.
 * Skips cookies whose domain doesn't match google.com.
 * Returns the count of successfully injected cookies.
 */
async function injectCookies(cookies, electronSession) {
  let injected = 0;
  for (const c of cookies) {
    if (!c.domain?.includes('google.com')) continue;
    try {
      await electronSession.cookies.set({
        url:            `https://${c.domain.replace(/^\./, '')}`,
        name:           c.name,
        value:          c.value,
        domain:         c.domain,
        path:           c.path || '/',
        secure:         c.secure  ?? false,
        httpOnly:       c.httpOnly ?? false,
        expirationDate: c.expires > 0 ? c.expires : undefined,
        // CDP uses 'Strict' / 'Lax' / 'None'; Electron expects lowercase equivalents.
        sameSite: (() => {
          const s = (c.sameSite || '').toLowerCase();
          if (s === 'strict') return 'strict';
          if (s === 'lax')    return 'lax';
          return 'no_restriction'; // covers 'None' and anything else
        })(),
      });
      injected++;
    } catch { /* a single cookie failing is not fatal */ }
  }
  console.log(`[chrome-bridge] Injected ${injected}/${cookies.length} Google cookies into Electron session`);
  return injected;
}

/**
 * Checks if the given cookie array contains a live Google session cookie.
 */
function hasActiveSession(cookies) {
  return cookies.some(c => SESSION_COOKIE_RE.test(c.name) && c.domain?.includes('google.com'));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempts to silently extract Google cookies from a Chrome instance that is
 * already running on CDP_PORT (e.g. from a previous call to seedSession that
 * left Chrome open, or a user-managed Chrome with --remote-debugging-port).
 *
 * Returns null if Chrome is not reachable or has no active session.
 */
async function trySilentExtract(electronSession) {
  try {
    const cookies = await extractCookies(CDP_PORT);
    if (!hasActiveSession(cookies)) return null;
    const injected = await injectCookies(cookies, electronSession);
    return { success: true, injected, requiresSignIn: false };
  } catch {
    return null;
  }
}

/**
 * Main entry point: seed the Electron WebContentsView session with real
 * Google cookies sourced from Chrome (via CDP).
 *
 * Algorithm:
 *   1. Try silent extraction (Chrome already running + signed in) — fast path.
 *   2. Find Chrome executable. If not installed, bail out gracefully.
 *   3. Launch Chrome with FlowKit's dedicated profile + CDP port.
 *   4. If the profile already has a valid session: extract immediately (~2s).
 *   5. If not: wait up to 5 minutes for the user to sign in to Google in the
 *      Chrome window, then extract on detection.
 *   6. Inject cookies into the Electron session and return.
 *
 * The caller should surface UI feedback while this is pending (the returned
 * promise resolves only after the user signs in on first run).
 *
 * @param {Electron.Session} electronSession
 * @param {object}           [options]
 * @param {boolean}          [options.silent=false] - If true, skip launching Chrome
 *                           and only try the fast path.
 * @returns {Promise<{ success: boolean, injected: number, requiresSignIn: boolean, error?: string }>}
 */
async function seedSession(electronSession, { silent = false } = {}) {
  // Fast path: Chrome is already running and has cookies.
  const silent_result = await trySilentExtract(electronSession);
  if (silent_result) return silent_result;

  if (silent) {
    return { success: false, injected: 0, requiresSignIn: false };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.warn('[chrome-bridge] Chrome/Edge not installed — cannot use Chrome auth bridge');
    return { success: false, injected: 0, requiresSignIn: false, error: 'Chrome not installed' };
  }

  launchChrome(chromePath);

  try {
    // Wait for CDP to become available (Chrome starts within a few seconds).
    const wsUrl = await waitForCDPReady(CDP_PORT, 15000);

    // Check if the FlowKit Chrome profile already has a valid Google session.
    // This is the common case after the user has signed in at least once.
    const [, cookiesResult] = await runCDP(wsUrl, [
      { method: 'Network.enable' },
      { method: 'Network.getCookies', params: { urls: GOOGLE_URLS } },
    ]);
    const initialCookies = cookiesResult?.cookies ?? [];

    if (hasActiveSession(initialCookies)) {
      // Profile has a cached session — inject without showing Chrome to the user.
      // Chrome launched but will close immediately.
      const injected = await injectCookies(initialCookies, electronSession);
      killChrome();
      return { success: true, injected, requiresSignIn: false };
    }

    // No cached session — Chrome window is now visible for sign-in.
    // Poll for the SID cookie to appear (user signs in to Google in Chrome).
    console.log('[chrome-bridge] Waiting for user to sign in to Google in Chrome window...');
    const signedInCookies = await waitForSignIn(CDP_PORT);
    const injected = await injectCookies(signedInCookies, electronSession);

    // Keep Chrome open briefly so the user sees their Drive (confirms success).
    setTimeout(killChrome, 3000);

    return { success: true, injected, requiresSignIn: true };
  } catch (err) {
    killChrome();
    console.error('[chrome-bridge] seedSession failed:', err.message);
    return { success: false, injected: 0, requiresSignIn: true, error: err.message };
  }
}

/**
 * Polls the Chrome CDP port until a Google session cookie (SID / __Secure-1PSID)
 * appears, indicating the user has completed sign-in.
 * Times out after 5 minutes.
 */
async function waitForSignIn(port, timeoutMs = 5 * 60 * 1000) {
  const wsUrl    = await waitForCDPReady(port, 15000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const [, cookiesResult] = await runCDP(wsUrl, [
        { method: 'Network.enable' },
        { method: 'Network.getCookies', params: { urls: GOOGLE_URLS } },
      ]);
      const cookies = cookiesResult?.cookies ?? [];
      if (hasActiveSession(cookies)) return cookies;
    } catch { /* Chrome restarting or navigating, retry */ }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error('Google sign-in timed out after 5 minutes');
}

module.exports = {
  findChrome,
  seedSession,
  killChrome,
  launchChrome,
  CDP_PORT,
};
