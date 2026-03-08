<script>
  import { fly } from 'svelte/transition';
  import { currentSheetUrl, currentSheetIsNative } from '../stores/sheetState.js';
  import { authState } from '../stores/auth.js';
  import { launcherOpen, launcherMode, sheetFormat, sidebarView } from '../stores/uiState.js';
  import { showToast } from '../stores/toast.js';
  import { dispatchLocal } from '../lib/bridge.js';

  let inputValue    = '';
  let isFocused     = false;
  let selectedIndex = 0;

  // ── Recent sheets mode ────────────────────────────────────────────────────
  let recentMode     = false;
  let recentSheets   = [];
  let recentExpanded = false;

  $: isRecent = recentMode && isFocused;
  $: visibleRecents = recentSheets.slice(0, recentExpanded ? 10 : 5);

  $: if (!isFocused) { recentMode = false; recentExpanded = false; }

  function loadRecents() {
    window.flowkit?.getRecentSheets().then(r => { recentSheets = r || []; selectedIndex = 0; });
  }

  function openRecent(entry) {
    currentSheetIsNative.set(true);
    currentSheetUrl.set(entry.url);
    window.flowkit?.openSheet(entry.url);
    window.flowkit?.addRecentSheet(entry);
    inputValue = ''; isFocused = false; recentMode = false;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 86400000 && d.getDate() === now.getDate()) return 'today';
    if (diff < 172800000) return 'yesterday';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // ── Search mode (input starts with '/') ───────────────────────────────────
  let searchResults = [];
  let searching     = false;
  let searchTimeout;

  $: isSearching = inputValue.startsWith('/');

  $: if (isSearching) {
    const query = inputValue.slice(1).trim();
    if (query.length > 1) {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => performSearch(query), 300);
    } else {
      searchResults = [];
    }
  } else {
    searchResults = [];
  }

  async function performSearch(query) {
    if (!window.flowkit?.searchSheets) return;
    searching = true;
    try {
      searchResults = await window.flowkit.searchSheets(query);
      selectedIndex = 0;
    } catch (e) {
      searchResults = [];
    } finally {
      searching = false;
    }
  }

  function openSearchResult(file) {
    const url = `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
    currentSheetIsNative.set(true);
    currentSheetUrl.set(url);
    window.flowkit?.openSheet(url);
    window.flowkit?.addRecentSheet({ id: file.id, name: file.name, url });
    inputValue    = '';
    isFocused     = false;
    searchResults = [];
  }

  $: window.flowkit?.togglePalette(isFocused && (!inputValue || isSearching || isRecent));

  // ── Commands ──────────────────────────────────────────────────────────────
  function goHome() {
    currentSheetUrl.set('');
    window.flowkit?.goHome();
  }

  // Open the sheet editing view — jump to most recent sheet, or show launcher.
  async function openKit() {
    if ($currentSheetUrl) { isFocused = false; return; } // already in editing mode
    const recents = (await window.flowkit?.getRecentSheets()) ?? [];
    if (recents.length > 0) {
      const entry = recents[0];
      currentSheetIsNative.set(true);
      currentSheetUrl.set(entry.url);
      window.flowkit?.openSheet(entry.url);
      window.flowkit?.addRecentSheet(entry);
    } else {
      launcherMode.set('open');
      launcherOpen.set(true);
    }
    isFocused = false;
  }

  $: commands = [
    { id: 'kit',  label: $currentSheetUrl ? 'kit (active)' : 'open kit', shortcut: 'K', action: openKit },
    { id: 'open', label: 'open drive library', shortcut: 'O', action: () => { launcherMode.set('open');     launcherOpen.set(true); } },
    { id: 'new',  label: 'create new flow',    shortcut: 'N', action: () => { launcherMode.set('new-flow'); launcherOpen.set(true); } },
    ...($currentSheetUrl ? [{ id: 'wrap', label: fixingWrap ? 'fixing wrap…' : 'fix row wrapping', shortcut: 'W', action: runFixWrap }] : []),
    { id: 'recent', label: 'open recent sheet',   shortcut: 'R', action: () => { recentMode = true; recentExpanded = false; isFocused = true; loadRecents(); } },
    { id: 'select', label: 'find specific sheet', shortcut: '/', action: () => { inputValue = '/'; isFocused = true; setTimeout(() => document.getElementById('topbar-input')?.focus(), 0); } },
    { id: 'exit',   label: 'terminate session',   shortcut: '⎋', action: () => window.flowkit?.closeWindow() }
  ];

  // ── Single keydown handler (on window) ────────────────────────────────────
  function handleGlobalKeydown(e) {
    const tag      = document.activeElement?.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Ctrl+\ — toggle between kit and home views.
    if (e.key === '\\' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sidebarView.update(v => v === 'kit' ? 'home' : 'kit');
      return;
    }

    // Ctrl+. — focus the block search input (switch to kit view first if needed).
    if (e.key === '.' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sidebarView.set('kit');
      dispatchLocal('flowkit:focusSearch');
      return;
    }

    // Ctrl+/ (Win/Linux) or Cmd+/ (Mac) toggles the palette.
    if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (isFocused) {
        isFocused     = false;
        inputValue    = '';
        searchResults = [];
      } else {
        isFocused     = true;
        selectedIndex = 0;
        setTimeout(() => document.getElementById('topbar-input')?.focus(), 0);
      }
      return;
    }

    if (!isFocused) return;

    const activeList = isRecent ? visibleRecents : (isSearching ? searchResults : commands);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (activeList.length) selectedIndex = (selectedIndex + 1) % activeList.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeList.length) selectedIndex = (selectedIndex - 1 + activeList.length) % activeList.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isRecent) {
        if (visibleRecents[selectedIndex]) openRecent(visibleRecents[selectedIndex]);
      } else if (isSearching) {
        if (searchResults[selectedIndex]) openSearchResult(searchResults[selectedIndex]);
      } else if (!inputValue) {
        commands[selectedIndex]?.action();
        if (!recentMode) isFocused = false;
      } else {
        processUrl();
      }
    } else if (e.key === 'Escape') {
      if (recentMode) { recentMode = false; }
      else { isFocused = false; inputValue = ''; searchResults = []; }
    } else if (!inputValue && !isSearching && !isRecent) {
      switch (e.key.toLowerCase()) {
        case 'o': e.preventDefault(); commands.find(c => c.id === 'open')?.action(); isFocused = false; break;
        case 'n': e.preventDefault(); commands.find(c => c.id === 'new')?.action();  isFocused = false; break;
        case 'k': e.preventDefault(); openKit(); break;
        case 'w': e.preventDefault(); commands.find(c => c.id === 'wrap')?.action(); isFocused = false; break;
        case '/': e.preventDefault(); commands.find(c => c.id === 'select')?.action(); break;
        case 'r': e.preventDefault(); recentMode = true; recentExpanded = false; isFocused = true; loadRecents(); break;
      }
    }
  }

  // ── URL paste ─────────────────────────────────────────────────────────────
  function processUrl() {
    const url = inputValue.trim();
    if (url.includes('docs.google.com/spreadsheets')) {
      currentSheetIsNative.set(true);
      currentSheetUrl.set(url);
      window.flowkit?.openSheet(url);
      const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      const id = idMatch?.[1] || url;
      window.flowkit?.addRecentSheet({ id, name: 'pasted sheet', url });
      inputValue = '';
      isFocused  = false;
    } else {
      showToast('invalid source — paste a google sheets url');
    }
  }

  // ── Wrap fix ──────────────────────────────────────────────────────────────
  let fixingWrap = false;

  async function runFixWrap() {
    const match = $currentSheetUrl?.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const id    = match?.[1];
    if (!id || !window.flowkit?.fixSheetWrapping) return;
    fixingWrap = true;
    try {
      await window.flowkit.fixSheetWrapping(id);
    } finally {
      fixingWrap = false;
    }
  }

  // ── Format cycler + tab buttons ───────────────────────────────────────────
  const FORMAT_CYCLE = ['Policy', 'LD', 'PF'];
  let addingTab = false;

  function cycleFormat() {
    sheetFormat.update(f => FORMAT_CYCLE[(FORMAT_CYCLE.indexOf(f) + 1) % FORMAT_CYCLE.length]);
  }

  async function addTab(tabName) {
    if (!$currentSheetIsNative) {
      showToast('flowkit only supports adding flow sheets to google sheets docs — switch to a doc with a green icon, or make a new flow from a template', 'warning', 6000);
      return;
    }
    const match = $currentSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const spreadsheetId = match?.[1];
    if (!spreadsheetId || !window.flowkit) return;
    addingTab = true;
    try {
      const result = await window.flowkit.addFlowTab({ spreadsheetId, tabName, format: $sheetFormat });
      if (!result?.usedTemplate) {
        showToast('no template linked — tab created with default column formatting', 'warning');
      }
    } catch (e) {
      showToast(e.message || 'failed to add tab');
    } finally {
      addingTab = false;
    }
  }
</script>

<svelte:window on:keydown={handleGlobalKeydown} />

<header class="orchestrator">

  <!-- ── Row 1: Command palette ─────────────────────────────────────────── -->
  <div class="top-row">
    <div class="commander" class:active={isFocused}>
      <div class="input-wrapper">
        <span class="prompt">$</span>
        <input
          id="topbar-input"
          type="text"
          bind:value={inputValue}
          on:focus={() => { isFocused = true; inputValue = ''; selectedIndex = 0; }}
          on:blur={() => setTimeout(() => { isFocused = false; }, 200)}
          placeholder={isFocused ? 'select command, paste link, or / to search…' : 'ctrl+/ commands'}
          spellcheck="false"
        />
      </div>

      {#if isFocused && (!inputValue || isRecent)}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="palette" in:fly={{ y: -5, duration: 100 }} on:mousedown|preventDefault>
          {#if isRecent}
            {#if recentSheets.length === 0}
              <div class="palette-msg">no recent sheets yet</div>
            {:else}
              <div class="palette-section-label">recent</div>
              {#each visibleRecents as entry, i}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <button
                  class="palette-item"
                  class:selected={i === selectedIndex}
                  on:click={() => openRecent(entry)}
                  on:mouseenter={() => (selectedIndex = i)}
                >
                  <span class="cmd-label"><span class="file-icon">⊞</span>{entry.name}</span>
                  <span class="cmd-shortcut recent-date">{fmtDate(entry.openedAt)}</span>
                </button>
              {/each}
              {#if recentSheets.length > 5 && !recentExpanded}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <button class="palette-more" on:click={() => { recentExpanded = true; }}>
                  ▾ show {recentSheets.length - 5} more
                </button>
              {/if}
            {/if}
          {:else}
            {#each commands as cmd, i}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <button
                class="palette-item"
                class:selected={i === selectedIndex}
                on:click={cmd.action}
                on:mouseenter={() => (selectedIndex = i)}
              >
                <span class="cmd-label">{cmd.label}</span>
                <span class="cmd-shortcut">{cmd.shortcut}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
      {#if isSearching}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="palette" in:fly={{ y: -5, duration: 100 }} on:mousedown|preventDefault>
          {#if searching}
            <div class="palette-msg">searching drive…</div>
          {:else if searchResults.length > 0}
            {#each searchResults as file, i}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <button
                class="palette-item"
                class:selected={i === selectedIndex}
                on:click={() => openSearchResult(file)}
                on:mouseenter={() => (selectedIndex = i)}
              >
                <span class="cmd-label"><span class="file-icon">⊞</span>{file.name}</span>
                <span class="cmd-shortcut">open</span>
              </button>
            {/each}
          {:else if inputValue.length > 1}
            <div class="palette-msg">no sheets found for "{inputValue.slice(1)}"</div>
          {:else}
            <div class="palette-msg">type to search your drive…</div>
          {/if}
        </div>
      {/if}
    </div>

    <button class="close-trigger" on:click={() => window.flowkit?.closeWindow()} title="Close">
      <div class="close-icon"></div>
    </button>
  </div>

  <!-- ── Row 2: Context controls ────────────────────────────────────────── -->
  <div class="bottom-row">
    <div class="controls-left">
      {#if $currentSheetUrl}
        <!-- View toggle: switches between kit (blocks) and home (manage) without
             clearing the sheet URL or reloading the tab. -->
        {#if $sidebarView === 'kit'}
          <button class="home-btn" on:click={() => sidebarView.set('home')} title="Manage templates & tubs">manage</button>
          <button class="fmt-btn" on:click={cycleFormat} title="Cycle format">
            {$sheetFormat.toLowerCase()}
          </button>
          <div class="tab-strip" class:busy={addingTab}>
            <button class="tab-btn" on:click={() => addTab('Adv')} disabled={addingTab}>+aff</button>
            <button class="tab-btn" on:click={() => addTab('OFF')} disabled={addingTab}>+neg</button>
            <button class="tab-btn" on:click={() => addTab('DA')}  disabled={addingTab}>+DA</button>
            <button class="tab-btn" on:click={() => addTab('T')}   disabled={addingTab}>+T</button>
            <button class="tab-btn" on:click={() => addTab('CP')}  disabled={addingTab}>+CP</button>
            <button class="tab-btn" on:click={() => addTab('K')}   disabled={addingTab}>+K</button>
          </div>
        {:else}
          <button class="home-btn kit-btn" on:click={() => sidebarView.set('kit')} title="Back to flow kit">← kit</button>
          <button class="fmt-btn" on:click={cycleFormat} title="Cycle format">
            {$sheetFormat.toLowerCase()}
          </button>
          <div class="tab-strip" class:busy={addingTab}>
            <button class="tab-btn" on:click={() => addTab('Adv')} disabled={addingTab}>+aff</button>
            <button class="tab-btn" on:click={() => addTab('OFF')} disabled={addingTab}>+neg</button>
            <button class="tab-btn" on:click={() => addTab('DA')}  disabled={addingTab}>+DA</button>
            <button class="tab-btn" on:click={() => addTab('T')}   disabled={addingTab}>+T</button>
            <button class="tab-btn" on:click={() => addTab('CP')}  disabled={addingTab}>+CP</button>
            <button class="tab-btn" on:click={() => addTab('K')}   disabled={addingTab}>+K</button>
          </div>
        {/if}
      {:else}
        <span class="app-name">flowkit <span class="version">v1.0.4</span></span>
      {/if}
    </div>

    <div class="controls-right">
      {#if $authState.loggedIn}
        <button class="user-pill" on:click={() => launcherOpen.set(true)}>
          <span class="user-id">{$authState.userInfo?.email.split('@')[0]}</span>
          <span class="status-online"></span>
        </button>
      {:else}
        <button class="auth-trigger" on:click={() => launcherOpen.set(true)}>sign in</button>
      {/if}
    </div>
  </div>

</header>

<style>
  :root {
    --bg: #0a0a0a;
    --surface: #121212;
    --border: #262626;
    --text-main: #e5e5e5;
    --text-dim: #737373;
    --accent: #ffffff;
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .orchestrator {
    position: fixed;
    top: 0; left: 0; right: 0;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono);
    z-index: 1000;
  }

  /* ── Row 1: Palette ────────────────────────────────────────────────────── */
  .top-row {
    height: 40px;
    display: flex;
    align-items: center;
    padding: 0 8px;
    gap: 6px;
    border-bottom: 1px solid var(--border);
  }

  .commander {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .input-wrapper {
    background: var(--surface);
    border: 1px solid var(--border);
    height: 28px;
    display: flex;
    align-items: center;
    padding: 0 10px;
    gap: 7px;
  }

  .prompt { color: var(--text-dim); font-size: 13px; }

  input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
    min-width: 0;
  }
  input::placeholder { color: var(--text-dim); text-transform: lowercase; }

  /* ── Palette dropdown ─────────────────────────────────────────────────── */
  .palette {
    position: absolute;
    top: 34px; left: 0; right: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8);
    padding: 4px;
    z-index: 100;
  }

  .palette-item {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 10px;
    background: none;
    border: none;
    font-family: var(--font-mono);
    text-align: left;
    cursor: pointer;
    border-radius: 2px;
  }
  .palette-item.selected { background: var(--accent); }
  .palette-item.selected .cmd-label,
  .palette-item.selected .cmd-shortcut { color: #000; }

  .cmd-label    { color: var(--text-main); font-size: 12px; text-transform: lowercase; }
  .cmd-shortcut { color: var(--text-dim);  font-size: 11px; flex-shrink: 0; margin-left: 8px; }

  .palette-msg {
    padding: 8px 10px;
    font-size: 11px;
    color: var(--text-dim);
    text-transform: lowercase;
  }

  .file-icon { color: #1a73e8; margin-right: 5px; font-size: 12px; }

  .palette-section-label {
    padding: 5px 10px 3px;
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .recent-date { font-size: 10px; color: var(--text-dim); }
  .palette-item.selected .recent-date { color: #555; }

  .palette-more {
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    text-align: left;
    cursor: pointer;
  }
  .palette-more:hover { color: var(--text-main); }

  /* ── Close button (top-row right) ─────────────────────────────────────── */
  .close-trigger {
    background: none; border: none; cursor: pointer;
    width: 20px; height: 20px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .close-icon {
    width: 10px; height: 1px;
    background: var(--text-dim);
    transform: rotate(45deg);
    position: relative;
  }
  .close-icon::after {
    content: '';
    position: absolute;
    width: 10px; height: 1px;
    background: var(--text-dim);
    transform: rotate(-90deg);
  }
  .close-trigger:hover .close-icon,
  .close-trigger:hover .close-icon::after { background: #ff4545; }

  /* ── Row 2: Context controls ───────────────────────────────────────────── */
  .bottom-row {
    height: 32px;
    display: flex;
    align-items: center;
    padding: 0 6px;
    gap: 6px;
    justify-content: space-between;
  }

  .controls-left {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .controls-left::-webkit-scrollbar { display: none; }

  .controls-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .app-name {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-main);
    white-space: nowrap;
  }
  .version { color: var(--text-dim); font-weight: 400; margin-left: 3px; }

  .home-btn {
    background: #0f0f1a;
    border: 1px solid #2a2a4a;
    border-radius: 3px;
    color: #8888cc;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 7px;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .home-btn:hover { background: #141426; border-color: #5555aa; color: #aaaaee; }
  /* "← kit" button has a slightly different tint to signal return navigation */
  .kit-btn { color: #aaaacc; border-color: #3a3a5a; }

  .fmt-btn {
    background: none;
    border: 1px solid #252535;
    border-radius: 2px;
    color: #555577;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    cursor: pointer;
    text-transform: lowercase;
    flex-shrink: 0;
    transition: border-color 0.12s, color 0.12s;
    white-space: nowrap;
  }
  .fmt-btn:hover { border-color: #4444aa; color: #9999dd; }

  .tab-strip {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }
  .tab-strip.busy { opacity: 0.55; pointer-events: none; }

  .tab-btn {
    background: none;
    border: 1px solid #252535;
    border-radius: 2px;
    color: #b9b9bf;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 5px;
    cursor: pointer;
    letter-spacing: 0.04em;
    white-space: nowrap;
    flex-shrink: 0;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .tab-btn:hover:not(:disabled) {
    border-color: #5555aa;
    color: #aaaaee;
    background: #0f0f1a;
  }
  .tab-btn:disabled { opacity: 0.4; cursor: default; }

  /* ── Identity (right side of bottom row) ──────────────────────────────── */
  .user-pill {
    background: none; border: none;
    display: flex; align-items: center; gap: 5px;
    cursor: pointer; padding: 2px;
  }
  .user-id {
    color: var(--text-main);
    font-size: 11px;
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
  }
  .status-online { width: 4px; height: 4px; background: var(--accent); flex-shrink: 0; }

  .auth-trigger {
    background: transparent;
    border: 1px solid var(--text-dim);
    color: var(--text-dim);
    font-size: 10px;
    font-family: var(--font-mono);
    padding: 2px 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .auth-trigger:hover { border-color: var(--accent); color: var(--accent); }
</style>
