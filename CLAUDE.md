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

