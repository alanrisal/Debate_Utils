/**
 * content-script.js — FlowKit Cell Tracker
 *
 * Runs inside every https://docs.google.com/spreadsheets/* page at document_idle.
 *
 * PURPOSE
 * ────────
 * Google Sheets renders on <canvas> and blocks execCommand/synthetic keyboard
 * events. DOM-based paste injection is not possible. Instead, FlowKit writes
 * block content via the Sheets REST API, which requires knowing the currently
 * selected cell. This script tracks that cell and reports it to the service
 * worker whenever it changes.
 *
 * HOW CELL TRACKING WORKS
 * ────────────────────────
 * Google Sheets keeps the active cell address in the Name Box — the input field
 * in the top-left corner of the formula bar (e.g. "B3", "A1:C5"). We read that
 * value on every click and relevant keypress and send it to the service worker
 * via chrome.runtime.sendMessage so the SW always has a fresh cell reference
 * ready when the user triggers a block injection from the sidebar.
 *
 * WHAT THIS SCRIPT DOES NOT DO
 * ─────────────────────────────
 * It does not attempt to paste, dispatch keyboard events, or manipulate the
 * Sheets DOM in any way. All write operations go through the service worker
 * using the authenticated Sheets REST API.
 */

// ── Cell address helpers ──────────────────────────────────────────────────────

/**
 * Read the currently selected cell/range from the Name Box (formula bar input).
 * Returns a string like "A1" or "B3:C5", or null if the element isn't found.
 *
 * Multiple selectors are tried in order because Google occasionally changes
 * the internal class names and aria attributes across Sheets releases.
 */
function getActiveCell() {
  // Strategy 1: scan all inputs for one whose current value looks like a cell
  // reference (A1, B3, AA10, A1:C5, etc.). This is selector-agnostic and
  // survives any Google Sheets class/aria rename across releases.
  const inputs = document.querySelectorAll('input');
  for (const input of inputs) {
    const val = input.value?.trim();
    if (val && /^[A-Z]{1,3}\d+(:[A-Z]{1,3}\d+)?$/.test(val)) {
      return val;
    }
  }

  // Strategy 2: fall back to any element that carries a cell-ref-related
  // class or id, in case the Name Box is rendered as something other than
  // a plain <input> in future Sheets versions.
  const formulaBar = document.querySelector(
    '.cell-ref, [id*="cell-ref"], [class*="cell-ref"]'
  );
  if (formulaBar?.value?.trim()) return formulaBar.value.trim();

  return null;
}

/**
 * Read the name of the currently active sheet tab from the tab strip at the
 * bottom of the Sheets UI. Returns the sheet title string or null.
 *
 * Including the sheet name lets the service worker build a fully-qualified
 * range like "Neg!B3" so writes land on the correct tab in multi-tab flows.
 */
function getActiveSheet() {
  // The active sheet tab in the bottom strip. Multiple selectors for resilience.
  // We target the element that holds just the tab label text, not the whole tab
  // container (which can include button icons and inflate the string).
  const activeTab =
    document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name') ||
    document.querySelector('.docs-sheet-active-tab')                       ||
    document.querySelector('[aria-selected="true"][data-sheet-id]');

  return activeTab?.textContent?.trim() || null;
}

// ── Cell reporting ────────────────────────────────────────────────────────────

/**
 * Read the current cell and sheet, then send a CELL_SELECTED message to the
 * service worker. The SW stores this so it can write to the correct cell when
 * the user injects a block from the sidebar.
 *
 * The message includes the current page URL so the SW can extract the
 * spreadsheet ID without needing a separate lookup.
 *
 * Errors are silently swallowed — the SW is not always running and the
 * "no receiving end" error during SW cold-start is expected and harmless.
 */
function reportCell() {
  const cell  = getActiveCell();
  const sheet = getActiveSheet();

  // Only report when we actually have a cell reference — avoids flooding the
  // SW with empty messages during page load before Sheets initialises.
  if (!cell) return;

  // Extract the numeric sheet ID (gid) from the URL hash: #gid=123456.
  // The batchUpdate GridRange API requires this numeric ID, not the sheet name.
  const gidMatch = window.location.hash.match(/gid=(\d+)/);
  const gid = gidMatch ? parseInt(gidMatch[1], 10) : 0;

  chrome.runtime.sendMessage({
    type:  'CELL_SELECTED',
    cell,           // e.g. "B3"
    sheet,          // e.g. "Neg" — may be null if tab strip not found
    gid,            // numeric sheetId for batchUpdate GridRange
    url:   window.location.href,  // SW extracts spreadsheetId from this
  }).catch(() => {
    // Service worker may be inactive. The next reportCell call will succeed
    // once Chrome restarts it. No action needed.
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Report on mouse release — covers click-to-select and click-drag selections.
// This sets the initial reference point for sidebar arrow-key navigation.
// Arrow key movement is now owned by the sidebar (BlockPanel), so we no longer
// report on keyup — that would conflict with sidebar-driven cell tracking.
document.addEventListener('mouseup', reportCell);

// Report immediately on load so the SW has a cell reference from the moment
// the content script injects, before the user has clicked anything.
// Use a short delay to allow Sheets to finish initialising its UI.
setTimeout(reportCell, 1000);

// ── Ctrl+. / Cmd+. → focus FlowKit sidebar search ────────────────────────────
//
// When focus is in the Sheets tab the sidebar can't receive keyboard events
// directly. The content script intercepts Ctrl+. here and sends FOCUS_SEARCH
// to the extension runtime. main.js listens and dispatches flowkit:focusSearch,
// which App.svelte's existing handler picks up to focus the search input.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== '.') return;

  // Prevent Sheets from acting on this keystroke.
  e.preventDefault();
  e.stopPropagation();

  chrome.runtime.sendMessage({ type: 'FOCUS_SEARCH' }).catch(() => {});
}, true); // capture phase so we beat Sheets' own key handler

// ── FOCUS_SHEET → reclaim keyboard focus for the Sheets tab ──────────────────
//
// Sent by the service worker immediately after a block inject completes.
// window.focus() requests that Chrome move keyboard focus from the sidebar
// back to this tab so the user can click the next cell without touching the mouse.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FOCUS_SHEET') return false;
  window.focus();
  sendResponse({ ok: true });
  return false;
});
