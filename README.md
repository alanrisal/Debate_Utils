# FlowKit — Project Description Document
> Version 1.0 | Living Document

---

## 1. Product Overview

**FlowKit** is a desktop application for competitive debaters (Policy, LD, and Public Forum) that wraps Google Sheets with a high-speed, debate-aware interface. It embeds Google Sheets directly inside an Electron shell to preserve real-time collaboration and familiar UX, while layering on a killer feature that no existing tool offers: **instant, context-aware block autofill from local Verbatim .docx files**.

FlowKit is not a Google Sheets replacement. It is a focused productivity layer on top of it — purpose-built for the specific, time-critical workflows of flowing a debate round.

---

## 2. What FlowKit Is

- A **downloadable desktop app** (Electron-based) for Mac and Windows (Linux later)
- An **embedded Google Sheets experience** — the sheet renders natively inside the app via webview/iframe
- A **block autofill engine** — parses local Verbatim .docx files and surfaces the most relevant pre-written blocks as you type, in a non-disruptive side panel
- A **team collaboration tool** — all real-time multi-user collab is handled by Google Sheets itself; FlowKit doesn't reinvent that
- A **format-aware flow tool** — with pre-built column templates for Policy, LD, and PF rounds
- A **local-first block library** — block files live on the user's machine; no cloud backend stores debate files
- A **monetizable software product** — distributed and charged per seat/team license

---

## 3. What FlowKit Is NOT

- Not a Google Sheets clone or replacement
- Not an offline tool — requires internet for Google Sheets sync
- Not a cloud storage solution for block files (files stay local for security/privacy)
- Not a general-purpose note-taking app
- Not a web app (desktop only, at least v1)
- Not Verbatim (the Word macro tool) — complementary, not competitive
- Not Flower or any other existing flow tool
- Not trying to replicate every Google Sheets feature — the embedded sheet handles that

---

## 4. Target Users

**Primary (v1):** Competitive Policy, LD, and PF debate teams at the high school and collegiate level

**Distribution model:** Direct download; team or per-seat licensing. Initially built for internal team use, then distributed publicly.

**User profile:**
- Tech-comfortable but not developers
- Under extreme time pressure during rounds (flowing happens in real time)
- Have existing Verbatim block files with hundreds of pre-written answers
- Already use Google Drive / Google Sheets for collaboration

---

## 5. Core Features

### 5.1 Embedded Google Sheets (Primary Interface)
- Electron `BrowserView` or `<webview>` tag embedding `sheets.google.com`
- Google OAuth 2.0 login — users authenticate once
- Users link a Google Drive folder; FlowKit shows a launcher to open flow sheets
- All real-time collaboration (multi-cursor, live edits) handled by Google Sheets natively
- No custom sheet rendering — pure embedded Sheets

### 5.2 Block Autofill Engine (Killer Feature)
- Users load local Verbatim .docx files into FlowKit's block library (stored on device)
- FlowKit parses the .docx and indexes the three-tier Verbatim structure:
  - **Pocket** → top-level file/category label
  - **Hat** → subgroup (e.g., "Cap K", "Topicality")
  - **Block** → individual pre-written answer (e.g., "AT: Fairness", "AT: Education")
- When a user types a word or phrase into a sheet cell, a **side panel** activates (keyboard shortcut toggle, e.g., `Cmd/Ctrl + K`)
- The side panel shows a **ranked list of matching blocks** based on the typed query
- Matching uses **fuzzy + semantic hybrid search** — fast fuzzy for instant results, semantic layer for context relevance
- User selects a block, hits Enter — block text is injected into the active cell
- The injection is **non-disruptive**: does not interrupt the partner's editing flow on the shared sheet
- Block files are parsed once on load and cached locally (JSON index)

### 5.3 Format-Aware Flow Templates
- On new sheet creation, user selects a format:
  - **Policy** — columns: 1AC | 2NC | 1NR | 2NR | 2AC | 1AR | etc.
  - **LD** — columns: AC | NC | NR | AR | etc.
  - **PF** — columns: Pro Case | Con Case | Rebuttal | Summary | FF | etc.
- Templates pre-populate column headers in a new Google Sheet via the Sheets API
- User can always customize freely after

### 5.4 Google Drive Integration
- OAuth-based Drive access
- Folder picker to link a "debate season" folder
- Quick launcher to open any sheet in that folder within the embedded view

---

## 6. Verbatim File Structure (Parsing Spec)

Verbatim organizes .docx files with Word heading styles:

| Verbatim Level | Word Style | Example |
|---|---|---|
| Pocket | Heading 1 | `Topicality` |
| Hat | Heading 2 | `Cap K` |
| Block | Heading 3 | `AT: Fairness` |
| Card/body text | Normal/body | (the actual argument text) |

FlowKit parses these heading levels from .docx XML and builds an indexed structure:
```
{
  pocket: "Topicality",
  hat: "Cap K",
  block: "AT: Fairness",
  content: "Fairness is a voter because..."
}
```

Files are typically 200–500 blocks. Parsing happens once on file load; the index is stored locally as JSON.

---

## 7. Block Search Architecture

**Goal: sub-100ms response from keystroke to ranked results**

### Recommended Approach: Two-Layer Hybrid

**Layer 1 — Fuzzy Search (instant, synchronous)**
- Library: `Fuse.js` (runs in main or renderer process, in-memory)
- Searches block headers (`AT: Fairness`) and pocket/hat labels
- Returns results in <10ms for 500 blocks
- This is the primary search layer — always runs first

**Layer 2 — Semantic Re-ranking (optional, async)**
- Use a small local embedding model via `transformers.js` (WASM, no server needed)
- Re-ranks top fuzzy results by semantic similarity to the typed query
- Runs asynchronously and updates the panel if it returns before user acts
- Model: `all-MiniLM-L6-v2` or similar (fast, small footprint)

**Why this hybrid:**
- Fuzzy gives instant gratification — results appear before the user finishes typing
- Semantic catches "education = learning" type matches fuzzy would miss
- Both run locally — zero latency from network, zero privacy risk

---

## 8. Tech Stack

### Desktop Shell
- **Electron** (v28+) — Mac + Windows, proven for this use case
- `BrowserView` for embedding Google Sheets (avoids CSP issues with `<webview>`)

### Frontend UI (FlowKit chrome — panels, launcher, settings)
- **SvelteKit** or plain **Svelte** — matches debate-flow.vercel.app aesthetic, lightweight, fast
- Tailwind CSS for styling
- The "chrome" around the embedded sheet is minimal — primarily the side panel and toolbar

### Block Parsing
- **mammoth.js** — converts .docx to structured HTML/JSON in Node.js
- Parse heading levels to reconstruct Verbatim hierarchy

### Search
- **Fuse.js** — fuzzy search, runs in renderer process on in-memory index
- **transformers.js** — optional semantic layer (can ship in v2)

### Google Integration
- **Google Sheets REST API v4** — for template creation (pre-populating columns)
- **Google Drive API v3** — for folder browsing and sheet linking
- **Google OAuth 2.0** via Electron — `electron-google-oauth2` or custom PKCE flow
- The sheet itself renders via embedded `sheets.google.com` URL in BrowserView

### Local Storage
- **electron-store** — persist user prefs, linked folders, parsed block index cache
- Block .docx files stay in user-chosen local directory; FlowKit reads but does not copy them

### Build & Distribution
- **electron-builder** — Mac (.dmg) and Windows (.exe / NSIS installer)
- Auto-update via `electron-updater`

---

## 9. Architecture Diagram (Simplified)

```
┌─────────────────────────────────────────────┐
│                 Electron App                │
│                                             │
│  ┌──────────────┐   ┌─────────────────────┐ │
│  │  Svelte UI   │   │   Google Sheets     │ │
│  │  (Side Panel │   │   BrowserView       │ │
│  │   Launcher   │   │   (embedded)        │ │
│  │   Settings)  │   │                     │ │
│  └──────┬───────┘   └─────────────────────┘ │
│         │                                   │
│  ┌──────▼───────────────────────────────┐   │
│  │         Main Process (Node.js)       │   │
│  │  - .docx parsing (mammoth.js)        │   │
│  │  - Block index cache (electron-store)│   │
│  │  - Google OAuth flow                 │   │
│  │  - Sheets API calls (template setup) │   │
│  │  - IPC bridge to renderer            │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
  Local .docx files    Google APIs
  (user's machine)     (Sheets, Drive)
```

---

## 10. Key UX Principles

1. **Never interrupt the flow** — the side panel is non-blocking; your partner's typing is unaffected
2. **Keyboard-first** — every block action should be completable without a mouse
3. **Sub-second everything** — no action in the block panel should feel slow
4. **Minimal chrome** — the sheet takes up 85%+ of the screen; FlowKit UI is a thin, elegant layer
5. **Zero config to start** — OAuth → link folder → load block file → flow

---

## 11. What's Out of Scope for v1

- Offline mode
- Linux support
- Cloud sync of block files
- Native sheet rendering (non-embedded)
- Audio/video recording of rounds
- Judge paradigm lookup
- AI-generated blocks or arguments
- Mobile support

---

## 12. Success Metrics (v1)

- Block autofill completes in <200ms from query to ranked results displayed
- Embedding Google Sheets with no visual glitches on Mac and Windows
- Parsing a 300-block .docx file in <2 seconds
- App launches and is ready to flow in <5 seconds
- No crashes during a live round

---

## 13. Open Questions / Future Decisions

- Semantic search: ship in v1 or v2? (Recommend v2 — Fuse.js alone is likely sufficient)
- Pricing model: per-seat vs. team license vs. one-time purchase?
- Block library sharing: should teammates be able to sync block indexes via a shared Google Drive JSON file? (Nice v2 feature)
- Verbatim structure variance: some users may have non-standard heading levels — need a "remap headings" setting

---

*Document maintained alongside `CLAUDE.md` in the FlowKit repo root.*
