# CLAUDE.md — FlowKit

This file tells Claude Code everything it needs to know to work effectively on the FlowKit codebase. Read this before touching any code.

---

## What Is FlowKit

FlowKit is a desktop application (Electron + Svelte) for competitive debaters (Policy, LD, PF formats). It does two things:

1. **Embeds Google Sheets** inside an Electron shell so debaters can flow rounds using familiar Google Sheets collaboration, but with a purpose-built debate UI around it.
2. **Autofills debate blocks** from local Verbatim .docx files — when a user types a keyword, a side panel surfaces ranked matching pre-written arguments that can be injected into the sheet with a single keypress.

**This is NOT a Google Sheets clone.** The sheet renders inside a `BrowserView`. FlowKit only builds the chrome around it (side panel, launcher, settings, block library).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron (v28+) |
| Frontend UI | Svelte + Tailwind CSS |
| Sheet embedding | `BrowserView` (not `<webview>`) |
| .docx parsing | mammoth.js (in main process) |
| Fuzzy search | Fuse.js (in renderer, in-memory) |
| Semantic search | transformers.js / MiniLM (v2, not v1) |
| Local persistence | electron-store |
| Google Auth | OAuth 2.0 PKCE flow in Electron |
| Google APIs | Sheets API v4, Drive API v3 |
| Build/dist | electron-builder |
| Auto-update | electron-updater |

---

## Project Structure

```
flowkit/
├── CLAUDE.md                  ← you are here
├── PROJECT_DESCRIPTION.md     ← full product spec
├── package.json
├── electron/
│   ├── main.js                ← Electron main process
│   ├── preload.js             ← context bridge / IPC
│   ├── auth.js                ← Google OAuth flow
│   ├── parser.js              ← .docx parsing with mammoth.js
│   ├── store.js               ← electron-store config
│   └── sheets-api.js          ← Google Sheets/Drive REST calls
├── src/
│   ├── App.svelte             ← root component
│   ├── components/
│   │   ├── BlockPanel.svelte  ← the side panel (KILLER FEATURE)
│   │   ├── Launcher.svelte    ← Drive folder browser / sheet picker
│   │   ├── Toolbar.svelte     ← top bar with format selector, actions
│   │   └── Settings.svelte    ← block file management, auth
│   ├── stores/
│   │   ├── blockIndex.js      ← Svelte store holding parsed block data
│   │   ├── auth.js            ← auth state store
│   │   └── sheetState.js      ← current sheet/folder state
│   └── lib/
│       ├── search.js          ← Fuse.js search wrapper
│       └── inject.js          ← block injection logic into sheet cell
├── public/
└── dist/                      ← built output (gitignored)
```

---

## Core Concepts Claude Must Understand

### Verbatim File Structure
Verbatim is a Word macro tool debaters use. Block files are .docx with this heading hierarchy:

- **Heading 1** = Pocket (top-level file label, e.g. "Topicality")
- **Heading 2** = Hat (subgroup, e.g. "Cap Kritik", "T-USFG")
- **Heading 3** = Block (individual answer, e.g. "AT: Fairness", "AT: Education")
- **Body text** = the actual pre-written argument content

mammoth.js in `electron/parser.js` reads .docx and extracts this hierarchy into a flat JSON array:
```json
[
  {
    "pocket": "Topicality",
    "hat": "Cap Kritik",
    "block": "AT: Fairness",
    "content": "Fairness is a voter because...",
    "id": "unique-hash"
  }
]
```

This array is passed to the renderer via IPC and stored in the `blockIndex` Svelte store. Fuse.js runs on this array in-memory.

### The Block Panel (Most Important Component)
- Lives in a fixed right-side panel (~300px wide), toggled with `Cmd+K` / `Ctrl+K`
- Has a search input — user types a query (e.g. "fairness")
- Fuse.js searches `block` field primarily, `hat` and `pocket` secondarily
- Results show as ranked cards: Block title, Hat label, relevance score
- User navigates with arrow keys, hits Enter to insert
- Insertion happens via IPC → main process → executes a keyboard shortcut or Sheets API call to paste content into the active cell
- **Must not steal focus from the sheet** — the panel search box should NOT auto-focus when the panel opens; user triggers it manually

### Sheet Embedding
- Use `BrowserView` in main process, NOT `<webview>` in renderer (CSP issues)
- The BrowserView is positioned to fill the non-panel area of the window
- On panel toggle, resize the BrowserView accordingly
- URL pattern: `https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit`
- Auth cookies from the OAuth flow should allow the sheet to load logged-in

### Google Auth
- PKCE flow — open system browser for consent, capture redirect on localhost callback
- Scopes needed: `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/drive.readonly`
- Store tokens in electron-store (encrypted)
- Refresh tokens automatically before expiry

### Format Templates
When a user creates a new flow sheet, FlowKit calls Sheets API to pre-populate column headers:

| Format | Columns |
|---|---|
| Policy | 1AC, CX, 2NC, CX, 1AR, 2NR, 2AR |
| LD | AC, CX, NC, CX, 1AR, NR, 2AR |
| PF | Pro Case, Con Case, Rebuttal, Summary, FF |

---

## IPC Channels (Electron Main ↔ Renderer)

| Channel | Direction | Purpose |
|---|---|---|
| `blocks:load` | renderer → main | User picks a .docx file to load |
| `blocks:loaded` | main → renderer | Returns parsed block JSON array |
| `blocks:inject` | renderer → main | User selected a block, inject into sheet cell |
| `auth:start` | renderer → main | Trigger OAuth flow |
| `auth:complete` | main → renderer | Auth done, pass user info |
| `sheet:open` | renderer → main | Open a sheet URL in BrowserView |
| `panel:toggle` | renderer → main | Resize BrowserView for panel open/close |
| `drive:list` | renderer → main | List sheets in linked Drive folder |

---

## Development Commands

```bash
# Install dependencies
npm install

# Run in development
npm run dev          # starts Vite for Svelte + Electron concurrently

# Build for distribution
npm run build        # builds Svelte
npm run dist         # packages with electron-builder

# Run tests
npm test
```

---

## Style & Code Guidelines

- **Svelte components**: keep them small and single-purpose
- **No React, no Vue** — Svelte only for the UI layer
- **Tailwind utility classes** — no custom CSS files unless unavoidable
- **IPC calls** should always have loading states in the UI
- **Never block the main process** — all file I/O is async
- **Fuse.js search** runs in the renderer process on the in-memory index — do NOT send search queries to main process
- **mammoth.js** runs in the main process — .docx files are read server-side (Node), not in the browser context
- Error handling: always surface parsing errors to the user gracefully (bad .docx format, auth failure, etc.)
- Keep the **BrowserView as the dominant UI element** — FlowKit chrome should feel thin and unobtrusive

---

## What NOT To Build

- Do not build a custom sheet renderer — the embedded Google Sheet handles all of that
- Do not sync block files to any cloud — they stay local only
- Do not build offline support — requires internet for Sheets
- Do not build semantic search in v1 — Fuse.js is sufficient; transformers.js is a v2 feature
- Do not add AI block generation — out of scope

---

## Key Performance Requirements

- Block panel search results: **<100ms** from keystroke to rendered results
- .docx parsing for 300-block file: **<2 seconds**
- App ready to use after launch: **<5 seconds**
- Block injection into sheet: **<300ms** perceived latency

---

## Reference

- [debate-flow.vercel.app](https://debate-flow.vercel.app) — UI inspiration (Svelte-based flow tool)
- [Google Sheets API v4 docs](https://developers.google.com/sheets/api)
- [Google Drive API v3 docs](https://developers.google.com/drive/api)
- [mammoth.js docs](https://github.com/mwilliamson/mammoth.js)
- [Fuse.js docs](https://www.fusejs.io/)
- [electron-builder docs](https://www.electron.build/)

## UPDATES MUST READ 2/19/26

Some new updates as of recently!
- Added full drive support and now I just made sure the API allows to edit and create files in google drive -- So using that our next step is to allow people to create new flows within their folders in drive all from our platform 

- after we've done that -- -we need to make sure that the functionality features in our top bar are all useful, so you can paste a spreadsheet URL, you can make a new sheet -- or do a bunch of commands from our control bar 

- finally we need to set up tubs --- this will be where people can upload files like 1AR block files or other blocks etc -- right now we just need a clean way to incorporate the block files into the sytem, we don tneed to create the classifiers yet 

# UPDATES *! 2/21/26 1:10am

Alright, where are we right now -- Read and write to google drive and sheets is compelte -- custom template selection has been established 

STEPS FORWARD

--- First thing to setup - 
A. Better dialogue for the function N make a new flow, you should get the drive popup but it should say select folder for new flow and then open the new flow box once the folder is selected instead of jsut doing the regular opening of the drive (low prioroity just simple to get out of the way and make sure UI is clean before moving forward)

B. We need to implement buttons to add new FLOW SHEETS (aff, neg) which is a core functionality:

Native Button → Sheet Mutation Pattern
To add buttons outside the embedded Google Sheets view that modify the sheet, use a three-layer IPC bridge:

Svelte UI — button calls window.flowkit.someAction(spreadsheetId) via the preload bridge
Preload script — exposes the method via contextBridge.exposeInMainWorld('flowkit', { someAction: (id) => ipcRenderer.invoke('some-action', id) })
Main process — registers ipcMain.handle('some-action', async (e, id) => { ... }) and calls the Google Sheets API via the googleapis Node SDK using the already-authenticated OAuth client

The embedded WebContentsView is then reloaded after the API call completes so it reflects the change. All auth/credentials stay in the main process and never touch the renderer. New sheet actions (add tab, pre-fill headers, apply formatting) follow this same pattern — just extend the flowkit bridge with a new method name and a corresponding ipcMain.handle on the other end. Sonnet 4.6

---

## BLOCK FILLING FEATURE — PLANNING & INFRASTRUCTURE ANALYSIS (2/21/26)

> This section is a design brief for the next major feature: real-time block suggestion and injection during a round. Do NOT begin implementing this until a separate design session has produced a finalized UI/UX plan. This section is intentionally comprehensive so it can be used as a standalone context document in another Claude window.

---

### What We Have Access To

**Sheets API v4 (main process, authenticated)**
- `spreadsheets.values.update` — write a value or block of text to any cell range (e.g. `Sheet1!B4`) in ~200–600ms round trip
- `spreadsheets.values.batchUpdate` — write to multiple ranges in one API call (lower total latency than sequential calls)
- `spreadsheets.values.get` — read current cell contents; can be used to find the next empty row in a column
- `spreadsheets.batchUpdate` — apply formatting (bold, background color, font size) to a range after writing
- Full knowledge of the spreadsheet's structure: we know the sheet ID, tab names, and column order for each format

**In-process block data**
- Parsed .docx tub files live in memory as a flat JSON array: `{ pocket, hat, block, content, id }`
- Fuse.js runs in the renderer — sub-10ms fuzzy search against hundreds of blocks once loaded
- Content strings can be arbitrarily long (full card text, tags, analytics)

**Electron Clipboard API**
- `require('electron').clipboard.writeText(str)` — synchronous, zero-latency write to the OS clipboard from main process
- Can be called immediately after user selects a block, before any API call
- Combined with a simulated Ctrl+V this is the fastest possible injection path

**WebContentsView control (main process)**
- `sheetView.webContents.focus()` — returns keyboard focus to the embedded sheet
- `sheetView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })` — simulate a paste keystroke into the sheet
- `sheetView.webContents.executeJavaScript(code)` — execute arbitrary JS inside the sheet's renderer context (powerful but restricted by Google Sheets' CSP; most DOM manipulation is blocked)

**Known format structure**
- We know the column layout for every format (Policy: 1AC=A, CX=B, 2NC=C…)
- If the user tells us which speech is "active," we can target the correct column without knowing the exact row

---

### What We Do NOT Have Access To

**The user's active cell position** — this is the central constraint. The WebContentsView is a fully sandboxed Chromium process. We cannot read which cell is selected, which row the cursor is on, or what text is currently in the active cell. Google Sheets exposes no postMessage or callback API for this.

**Sheet DOM access** — Google Sheets' canvas-based renderer means there is no meaningful DOM to query even if CSP allowed it. `executeJavaScript` can run in the page context but cannot read the sheet grid state.

**Google Sheets internal keyboard events** — we cannot intercept what the user types inside the sheet. Our Svelte UI listens for keydown on `<svelte:window>` but those events stop at the BrowserWindow layer; the WebContentsView has its own independent event loop.

**Programmatic cell selection** — the Sheets API has no "select cell X" endpoint. Selection is entirely a client-side UI concept.

**Real-time cell change events** — there is no webhook or push notification from Sheets API for cell edits. Polling `values.get` every few seconds is the only read option, and that is too slow/expensive for real-time use.

---

### Injection Strategies (ranked by latency & reliability)

**Strategy A — Clipboard + Simulated Paste (fastest, ~50ms perceived)**
1. User selects a block in our panel
2. Main process writes content to clipboard (`clipboard.writeText`)
3. Main process calls `sheetView.webContents.focus()` + sends `Ctrl+V` via `sendInputEvent`
4. Sheet pastes the block into whichever cell the user had selected

Pros: Near-instant. Cell-position agnostic — user controls exactly where it lands by clicking first. Works regardless of which column/row.
Cons: Overwrites the OS clipboard (annoying but acceptable during a round). `sendInputEvent` paste can be finicky if the sheet is mid-edit or if focus was on a cell that doesn't accept paste in that mode. Google Sheets sometimes interprets pasted newlines as multi-cell paste — long block content may spill across rows instead of staying in one cell.

**Strategy B — Sheets API `values.update` to a computed range (~300–700ms)**
1. User tells the panel which speech is active (e.g. "2NC")
2. We look up the column for that speech in the format map (e.g. column C for Policy)
3. We call `spreadsheets.values.get` for that column to find the next empty row (~200ms)
4. We call `spreadsheets.values.update` to write the block content to that cell (~300ms)
5. The sheet auto-refreshes in the WebContentsView (Google Sheets streams changes via websocket internally)

Pros: Surgically accurate. No clipboard corruption. Works even if user hasn't clicked into the sheet.
Cons: Two round-trip API calls. Total latency 500–900ms which is noticeable during a fast round. The "next empty row" logic assumes a top-down fill pattern which may not match how the debater flows.

**Strategy C — Hybrid: Optimistic Clipboard + API Confirm**
Write to clipboard immediately (instant UI feedback), also fire the API write in the background. If the API write lands in the wrong cell (user had sheet focus elsewhere), clipboard paste is still available as a fallback.

**Strategy D — User-specified cell coordinate**
A small input in the panel (like "B4") lets the user explicitly target a cell before injecting. Most precise but adds friction during a round.

---

### UI Concept A — "Speech-Aware Side Panel" (recommended starting point)

The right panel (~300px, toggled with Ctrl+K) is the primary block injection surface. It is always running a fuzzy search against the loaded tubs.

```
┌─────────────────────────────┐
│ SPEECH  [1AC ▾]  FORMAT: Policy │  ← user picks which speech they're flowing
├──────────────┬──────────────┤
│ 🔍 fairness  │              │  ← live search input (Fuse.js, <10ms)
├──────────────┴──────────────┤
│ ① AT: Fairness      95%    │  ← Tier 1: direct block match
│   Cap Kritik / Topicality   │
├─────────────────────────────┤
│ ② AT: Education     81%    │  ← same hat, adjacent block
│ ③ Fairness = Myth   74%    │
├─────────────────────────────┤
│   Generic T Shell   51%    │  ← Tier 2: same pocket, lower confidence
│   AT: Reasonability  49%   │
└─────────────────────────────┘
    [1] [2] [3]  Tab to cycle  Enter to inject
```

- **Number keys 1/2/3** inject the corresponding block immediately (Strategy A — clipboard+paste)
- **Tab** cycles the selection highlight through visible results
- **Enter** injects the currently highlighted block
- **Arrow keys** scroll through extended results
- Tiers visually separated by subtle dividers; top 3 are always visible above the fold
- The "SPEECH" dropdown tracks which column we're targeting for Strategy B API writes
- Search clears automatically after injection so the user can immediately start searching for the next argument

---

### UI Concept B — "Suggestion Strip" (minimal footprint)

A thin 40px strip pinned above the sheet view (below the toolbar), permanently visible:

```
┌────────────────────────────────────────────────────────────────┐
│  [1] AT: Fairness  [2] AT: Education  [3] Generic T Shell  🔍  │
└────────────────────────────────────────────────────────────────┘
```

- Only shows when a tub is loaded and a keyword has been typed (otherwise hidden, sheet gets full height)
- Alt+1 / Alt+2 / Alt+3 inject without leaving the sheet
- Clicking the 🔍 expands to full panel (Concept A)
- Requires very fast search to feel useful — Fuse.js easily meets this

---

### UI Concept C — "Trigger-Word Autocomplete"

Inspired by VS Code IntelliSense. As the user types in a cell, our app watches for a trigger sequence (e.g. user types `//fairness` in the sheet). We intercept this by polling the cell value via API at low frequency, detect the trigger, and surface a floating suggestion box.

Limitations: polling is too slow for real-time use. Cell value polling via Sheets API has significant latency and would burn API quota. This concept is NOT recommended for v1.

---

### Open Design Questions (resolve in separate session)

1. **Injection method**: Clipboard+paste (Strategy A) or API write (Strategy B) or hybrid? Strategy A is faster but has multi-row paste issues with long content. Should we truncate? Sanitize newlines → spaces?

2. **Cell targeting without cursor knowledge**: Does the debater pre-click their target cell before selecting a block? Or do we always write to "next empty row in active speech column"? The latter requires them to keep the speech selector updated.

3. **Block content format in a cell**: Full card text with tags and analytics in one cell (can be very long), or just the block name + a brief summary? Google Sheets cells can hold 50,000 chars but display becomes unwieldy.

4. **Multi-round tab management**: The speech selector in the panel needs to know which tab (Aff/Neg) is active. Should it read from the URL `#gid=` fragment? Or should the user set it manually?

5. **Tub loading UX**: Currently tubs are uploaded but not parsed. The parser (mammoth.js) needs to be wired up to populate the Fuse.js index. This is a prerequisite for any block panel work.

6. **Panel focus behavior**: Ctrl+K opens the panel and must NOT steal focus from the sheet (user's cell selection must be preserved). The search input inside the panel gets focus only when the user explicitly clicks it or presses a secondary shortcut.

7. **Keyboard shortcut conflict**: Alt+1/2/3 for injection must not conflict with Google Sheets' own shortcuts. Test on target platform before committing.

---

### Prerequisites Before Building (in order)

1. Wire up `mammoth.js` parser: `electron/parser.cjs` needs to be created, parse `.docx` tub files into the block JSON schema, and send results to the renderer via IPC (`tubs:parse`, `tubs:parsed`)
2. Create `blockIndex` Svelte store and load parsed tub data into it on startup / when tubs change
3. Initialize Fuse.js instance in the renderer against the `blockIndex` store
4. Build `BlockPanel.svelte` with search input + tiered results list
5. Implement the chosen injection strategy (clipboard or API)
6. Wire up the speech selector to the column map for API-targeted writes

