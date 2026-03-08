import { mount }                    from 'svelte';
import './app.css';
import App                          from './App.svelte';
import { flowkit, dispatchLocal }   from './lib/bridge.js';
import { targetCell }               from './stores/targetCell.js';

// Expose the Chrome Extension bridge as window.flowkit so every existing
// Svelte component that calls window.flowkit.* continues to work unchanged.
window.flowkit = flowkit;

// ── Runtime message listener ───────────────────────────────────────────────────
//
// Receives messages from the content script (CELL_SELECTED, FOCUS_SEARCH).
// Both types arrive here because chrome.runtime.sendMessage from a content
// script broadcasts to all extension pages including this sidebar.
chrome.runtime.onMessage.addListener((msg) => {
  // Content script reports which cell the user clicked in the sheet.
  // This seeds the targetCell store so BlockPanel arrow-key navigation
  // has a starting reference point.
  if (msg.type === 'CELL_SELECTED') {
    const idMatch = msg.url?.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    targetCell.set({
      cell:          msg.cell || null,
      gid:           msg.gid  ?? 0,
      spreadsheetId: idMatch  ? idMatch[1] : null,
    });
  }

  // Ctrl+. pressed in the Sheets tab → focus the sidebar search input.
  if (msg.type === 'FOCUS_SEARCH') {
    dispatchLocal('flowkit:focusSearch', null);
  }
});

const app = mount(App, {
  target: document.getElementById('app'),
});

export default app;
