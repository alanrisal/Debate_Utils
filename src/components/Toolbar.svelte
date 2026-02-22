<script>
  import { fly, fade } from 'svelte/transition';
  import { currentSheetUrl } from '../stores/sheetState.js';
  import { authState } from '../stores/auth.js';
  import { launcherOpen, launcherMode, sheetFormat, panelOpen } from '../stores/uiState.js';

  let inputValue    = '';
  let error         = '';
  let isFocused     = false;
  let selectedIndex = 0;

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
    currentSheetUrl.set(url);
    window.flowkit?.openSheet(url);
    inputValue    = '';
    isFocused     = false;
    searchResults = [];
  }

  // Move the native sheet view off-screen whenever the palette dropdown is visible.
  $: window.flowkit?.togglePalette(isFocused && (!inputValue || isSearching));

  // ── Commands ──────────────────────────────────────────────────────────────
  function goHome() {
    currentSheetUrl.set('');
    window.flowkit?.goHome();
  }

  $: commands = [
    ...($currentSheetUrl ? [{ id: 'home', label: 'go to home', shortcut: 'B', action: goHome }] : []),
    { id: 'open', label: 'open drive library', shortcut: 'O', action: () => { launcherMode.set('open');     launcherOpen.set(true); } },
    { id: 'new',  label: 'create new flow',    shortcut: 'N', action: () => { launcherMode.set('new-flow'); launcherOpen.set(true); } },
    ...($currentSheetUrl ? [{ id: 'wrap', label: fixingWrap ? 'fixing wrap…' : 'fix row wrapping', shortcut: 'W', action: runFixWrap }] : []),
    { id: 'exit', label: 'terminate session',  shortcut: '⎋', action: () => window.flowkit?.closeWindow() },
    { id: 'select', label: 'find specific sheet', shortcut: '/', action: () => { inputValue = '/'; isFocused = true; setTimeout(() => document.getElementById('topbar-input')?.focus(), 0); } },
  ];

  // ── Single keydown handler (on window) ────────────────────────────────────
  function handleGlobalKeydown(e) {
    const tag      = document.activeElement?.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // '>' toggles the palette from anywhere outside an existing input
    if (e.key === '>' && !isTyping) {
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

    const activeList = isSearching ? searchResults : commands;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (activeList.length) selectedIndex = (selectedIndex + 1) % activeList.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeList.length) selectedIndex = (selectedIndex - 1 + activeList.length) % activeList.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isSearching) {
        if (searchResults[selectedIndex]) openSearchResult(searchResults[selectedIndex]);
      } else if (!inputValue) {
        commands[selectedIndex]?.action();
        isFocused = false;
      } else {
        processUrl();
      }
    } else if (e.key === 'Escape') {
      isFocused     = false;
      inputValue    = '';
      searchResults = [];
    } else if (!inputValue && !isSearching) {
      // Single-letter shortcuts when palette is open with no text typed
      switch (e.key.toLowerCase()) {
        case 'o': e.preventDefault(); commands.find(c => c.id === 'open')?.action(); isFocused = false; break;
        case 'n': e.preventDefault(); commands.find(c => c.id === 'new')?.action();  isFocused = false; break;
        case 'b': e.preventDefault(); commands.find(c => c.id === 'home')?.action(); isFocused = false; break;
        case 'w': e.preventDefault(); commands.find(c => c.id === 'wrap')?.action(); isFocused = false; break;
      }
    }
  }

  // ── URL paste ─────────────────────────────────────────────────────────────
  function processUrl() {
    const url = inputValue.trim();
    if (url.includes('docs.google.com/spreadsheets')) {
      currentSheetUrl.set(url);
      window.flowkit?.openSheet(url);
      inputValue = '';
      isFocused  = false;
    } else {
      error = 'invalid source';
      setTimeout(() => (error = ''), 2000);
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

  // ── Format cycler + Aff / Neg tab buttons ─────────────────────────────────
  const FORMAT_CYCLE = ['Policy', 'LD', 'PF'];
  let addingTab = false;

  function cycleFormat() {
    sheetFormat.update(f => FORMAT_CYCLE[(FORMAT_CYCLE.indexOf(f) + 1) % FORMAT_CYCLE.length]);
  }

  async function addTab(tabName) {
    const match = $currentSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const spreadsheetId = match?.[1];
    if (!spreadsheetId || !window.flowkit) return;
    addingTab = true;
    try {
      await window.flowkit.addFlowTab({ spreadsheetId, tabName, format: $sheetFormat });
    } catch (e) {
      error = e.message || 'failed to add tab';
      setTimeout(() => (error = ''), 2500);
    } finally {
      addingTab = false;
    }
  }
</script>

<svelte:window on:keydown={handleGlobalKeydown} />

<header class="orchestrator">

  <!-- ── Left: meta / sheet controls ──────────────────────────────────── -->
  <div class="meta">
    {#if $currentSheetUrl}
      <button class="home-btn" on:click={goHome}>
        <span class="home-arrow">←</span>
        <span class="home-label">home</span>
      </button>
      <div class="sheet-controls" class:busy={addingTab}>
        <button class="fmt-btn" on:click={cycleFormat} title="Click to cycle format">
          {$sheetFormat.toLowerCase()}
        </button>
        <button class="tab-btn" on:click={() => addTab('Adv')} disabled={addingTab}>+aff</button>
        <button class="tab-btn" on:click={() => addTab('OFF')} disabled={addingTab}>+neg</button>
        <button class="tab-btn" on:click={() => addTab('DA')} disabled={addingTab}>+DA</button>
        <button class="tab-btn" on:click={() => addTab('T')} disabled={addingTab}>+T</button>
        <button class="tab-btn" on:click={() => addTab('CP')} disabled={addingTab}>+CP</button>
        <button class="tab-btn" on:click={() => addTab('K')} disabled={addingTab}>+K</button>

      </div>
    {:else}
      <span class="system-status"></span>
      <span class="app-name">flowkit <span class="version">v1.0.4</span></span>
    {/if}
  </div>

  <!-- ── Center: commander ─────────────────────────────────────────────── -->
  <div class="commander" class:active={isFocused}>
    <div class="input-wrapper">
      <span class="prompt">$</span>
      <input
        id="topbar-input"
        type="text"
        bind:value={inputValue}
        on:focus={() => { isFocused = true; }}
        on:blur={() => setTimeout(() => { isFocused = false; }, 200)}
        placeholder={isFocused ? 'select command, paste link, or / to search…' : '> open commands'}
        spellcheck="false"
      />
      {#if error}
        <span class="error-tag" transition:fade>{error}</span>
      {/if}
    </div>

    {#if isFocused && (!inputValue || isSearching)}
      <div class="palette" in:fly={{ y: -5, duration: 100 }}>
        {#if isSearching}
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
  </div>

  <!-- ── Right: identity ───────────────────────────────────────────────── -->
  <div class="identity">
    <button
      class="panel-toggle"
      class:panel-active={$panelOpen}
      on:click={() => window.flowkit?.togglePanel()}
      title="Toggle block panel (Ctrl+K)"
    >
      <span class="panel-icon"></span>
      <span class="panel-label">blocks</span>
    </button>

    {#if $authState.loggedIn}
      <button class="user-pill" on:click={() => launcherOpen.set(true)}>
        <span class="user-id">{$authState.userInfo?.email.split('@')[0]}</span>
        <span class="status-online"></span>
      </button>
    {:else}
      <button class="auth-trigger" on:click={() => launcherOpen.set(true)}>authenticate</button>
    {/if}
    <button class="close-trigger" on:click={() => window.flowkit?.closeWindow()}>
      <div class="close-icon"></div>
    </button>
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
    height: 46px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    font-family: var(--font-mono);
    -webkit-app-region: drag;
    z-index: 1000;
  }

  /* ── Left ─────────────────────────────────────────────────────────────── */
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 220px;
  }

  .system-status { width: 9px; height: 9px; border: 1px solid var(--text-dim); }
  .app-name { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-main); }
  .version { color: var(--text-dim); font-weight: 400; margin-left: 4px; }

  .home-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    background: #0f0f1a;
    border: 1px solid #2a2a4a;
    border-radius: 3px;
    color: #8888cc;
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 4px 10px 4px 8px;
    cursor: pointer;
    letter-spacing: 0.04em;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    -webkit-app-region: no-drag;
  }
  .home-btn:hover { background: #141426; border-color: #5555aa; color: #aaaaee; }
  .home-arrow { font-size: 13px; line-height: 1; }
  .home-label { text-transform: lowercase; letter-spacing: 0.06em; }

  .sheet-controls {
    display: flex;
    align-items: center;
    gap: 5px;
    -webkit-app-region: no-drag;
  }
  .sheet-controls.busy { opacity: 0.55; pointer-events: none; }

  .fmt-btn {
    background: none;
    border: 1px solid #252535;
    border-radius: 2px;
    color: #555577;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
    text-transform: lowercase;
    transition: border-color 0.12s, color 0.12s;
  }
  .fmt-btn:hover { border-color: #4444aa; color: #9999dd; }

  .tab-btn {
    background: none;
    border: 1px solid #252535;
    border-radius: 2px;
    color: #b9b9bf;
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 3px 8px;
    cursor: pointer;
    letter-spacing: 0.05em;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .tab-btn:hover:not(:disabled) {
    border-color: #5555aa;
    color: #aaaaee;
    background: #0f0f1a;
    transform: scale(1.12) translateY(-2px);
  }
  .tab-btn:disabled { opacity: 0.4; cursor: default; }

  /* ── Center ───────────────────────────────────────────────────────────── */
  .commander {
    position: relative;
    width: 440px;
    flex-shrink: 0;
    transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    -webkit-app-region: no-drag;
  }
  .commander.active { width: 520px; }

  .input-wrapper {
    background: var(--surface);
    border: 1px solid var(--border);
    height: 30px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 8px;
  }

  .prompt { color: var(--text-dim); font-size: 14px; }

  input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-family: var(--font-mono);
    font-size: 13px;
    outline: none;
  }
  input::placeholder { color: var(--text-dim); text-transform: lowercase; }

  .error-tag { color: #ff4545; font-size: 12px; text-transform: uppercase; }

  /* ── Palette dropdown ─────────────────────────────────────────────────── */
  .palette {
    position: absolute;
    top: 36px; left: 0; right: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8);
    padding: 4px;
    z-index: 10;
  }

  .palette-item {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
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

  .cmd-label    { color: var(--text-main); font-size: 13px; text-transform: lowercase; }
  .cmd-shortcut { color: var(--text-dim);  font-size: 12px; }

  .palette-msg {
    padding: 10px 12px;
    font-size: 12px;
    color: var(--text-dim);
    text-transform: lowercase;
  }

  .file-icon { color: #1a73e8; margin-right: 6px; font-size: 13px; }

  /* ── Right ────────────────────────────────────────────────────────────── */
  .identity {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 220px;
    justify-content: flex-end;
    -webkit-app-region: no-drag;
  }

  .panel-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 1px solid #252535;
    border-radius: 2px;
    color: #555577;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    padding: 4px 10px;
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .panel-toggle:hover { border-color: #4444aa; color: #9999dd; }
  .panel-toggle.panel-active {
    border-color: #5555cc;
    color: #aaaaff;
    background: #0d0d1a;
  }

  .panel-icon {
    width: 10px;
    height: 10px;
    border: 1px solid currentColor;
    border-radius: 1px;
    position: relative;
    flex-shrink: 0;
  }
  /* Right-side stripe to suggest the panel position */
  .panel-icon::after {
    content: '';
    position: absolute;
    top: 0; right: 0; bottom: 0;
    width: 3px;
    background: currentColor;
    border-radius: 0 1px 1px 0;
  }
  .panel-label { text-transform: lowercase; }

  .user-pill {
    background: none; border: none;
    display: flex; align-items: center; gap: 8px;
    cursor: pointer; padding: 4px;
  }
  .user-id { color: var(--text-main); font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
  .status-online { width: 4px; height: 4px; background: var(--accent); }

  .auth-trigger {
    background: transparent;
    border: 1px solid var(--text-dim);
    color: var(--text-dim);
    font-size: 12px;
    font-family: var(--font-mono);
    padding: 3px 10px;
    cursor: pointer;
  }
  .auth-trigger:hover { border-color: var(--accent); color: var(--accent); }

  .close-trigger {
    background: none; border: none; cursor: pointer;
    width: 20px; height: 20px;
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
</style>
