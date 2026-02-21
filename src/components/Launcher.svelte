<script lang="ts" context="module">
  declare global {
    interface Window {
      flowkit?: {
        listSharedDrives: () => Promise<any>;
        listSharedWithMe: () => Promise<any>;
        listFolder: (id: string) => Promise<any>;
        searchSheets: (query: string) => Promise<any>;
        getAuthStatus: () => Promise<any>;
        getTemplates: () => Promise<any>;
        getFormatLinks: () => Promise<any>;
        createFlowFromTemplate: (opts: any) => Promise<any>;
        createFlowSheet: (opts: any) => Promise<any>;
        openSheet: (url: string) => void;
        startAuth: () => Promise<any>;
        logout: () => Promise<any>;
        onAuthComplete: (cb: (data: any) => void) => () => void;
      };
    }
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { launcherOpen, launcherNewFormat, launcherMode } from '../stores/uiState.js';
  import { currentSheetUrl } from '../stores/sheetState.js';
  import { authState } from '../stores/auth.js';

  // ── constants ─────────────────────────────────────────────────────────────
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const SHEET_MIME        = 'application/vnd.google-apps.spreadsheet';
  const XLSX_MIME         = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const EXCEL_MIME_LEGACY = 'application/vnd.ms-excel';
  const EXCEL_MIME_MACRO  = 'application/vnd.ms-excel.sheet.macroenabled.12';

  // ── navigation stack ──────────────────────────────────────────────────────
  // Each entry: { id, name, type: 'folder'|'drive'|'sharedWithMe', driveId }
  // Empty stack = home view.
  let stack = [];

  // ── view state ────────────────────────────────────────────────────────────
  let sharedDrives = [];   // loaded once when home is shown
  let items        = [];   // current folder / sharedWithMe contents
  let loading      = false;
  let error        = '';
  let search       = '';
  let searchInput;
  let unsubAuth;

  // ── new flow form state ───────────────────────────────────────────────────
  let showNewFlow    = false;
  let newFlowName    = '';
  let newFlowFormat  = 'Policy';
  let creating       = false;
  let createError    = '';
  let newFlowInput;
  let userTemplates  = [];   // user-uploaded .xlsx templates
  let formatLinks    = { Policy: null, LD: null, PF: null };

  $: loc      = stack[stack.length - 1] ?? null;   // null = home
  $: isHome   = loc === null;
  $: filtered = search
    ? items.filter(f => f.name.toLowerCase().includes(search.toLowerCase()))
    : items;

  // ── helpers ───────────────────────────────────────────────────────────────
  function isFolder(item) { return item.mimeType === FOLDER_MIME; }
  function isSheet(item)  { return item.mimeType === SHEET_MIME || item.mimeType === XLSX_MIME || item.mimeType === EXCEL_MIME_LEGACY || item.mimeType === EXCEL_MIME_MACRO; }
  function isXlsx(item)   { return item.mimeType === XLSX_MIME || item.mimeType === EXCEL_MIME_LEGACY || item.mimeType === EXCEL_MIME_MACRO; }

  function relativeDate(iso) {
    if (!iso) return '';
    const rtf      = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const diffMs   = new Date(iso) - Date.now();
    const diffDays = Math.round(diffMs / 86_400_000);
    const abs      = Math.abs(diffDays);
    if (abs < 1)   return 'today';
    if (abs < 7)   return rtf.format(diffDays, 'day');
    if (abs < 30)  return rtf.format(Math.round(diffDays / 7),   'week');
    if (abs < 365) return rtf.format(Math.round(diffDays / 30),  'month');
    return               rtf.format(Math.round(diffDays / 365),  'year');
  }

  // ── data loading ──────────────────────────────────────────────────────────
  async function loadLocation(location) {
    if (!window.flowkit) return;
    loading = true;
    error   = '';
    search  = '';
    try {
      if (!location) {
        sharedDrives = await window.flowkit.listSharedDrives();
        items = [];
      } else if (location.type === 'sharedWithMe') {
        items = await window.flowkit.listSharedWithMe();
      } else {
        // 'folder' or 'drive' (shared drive root uses driveId as folderId).
        // allDrives corpus is used server-side so partner-created files are included.
        items = await window.flowkit.listFolder(location.id);
      }
    } catch (e) {
      error = e.message || 'Failed to load';
    } finally {
      loading = false;
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────
  async function navigate(entry) {
    stack = [...stack, entry];
    await loadLocation(entry);
    if ($launcherMode === 'new-flow' && entry.type !== 'sharedWithMe') {
      // Auto-open the new flow form; reset mode so further navigation doesn't re-trigger
      launcherMode.set('open');
      openNewFlowForm();
    } else if (searchInput) {
      setTimeout(() => searchInput?.focus(), 50);
    }
  }

  async function navigateTo(index) {
    // index -1 = go home
    stack = index < 0 ? [] : stack.slice(0, index + 1);
    await loadLocation(stack[stack.length - 1] ?? null);
  }

  function openSheet(file) {
    // .xlsx files: Drive provides a webViewLink that opens them in the Sheets editor.
    // Native Google Sheets: construct the edit URL directly.
    const url = (isXlsx(file) && file.webViewLink)
      ? file.webViewLink
      : `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
    currentSheetUrl.set(url);   // update the Svelte store so the back button appears
    window.flowkit?.openSheet(url);
    launcherOpen.set(false);
  }

  function clickItem(item) {
    if (isSheet(item)) {
      openSheet(item);
    } else if (isFolder(item)) {
      navigate({ id: item.id, name: item.name, type: 'folder', driveId: loc?.driveId ?? null });
    }
  }

  // -- keyboard navigation state --
  let selectedIndex = 0;

  // Create a unified list of navigable items based on the current view
  $: navItems = isHome 
    ? [
        { id: 'root', name: 'My Drive', type: 'folder', driveId: null },
        { id: 'sharedWithMe', name: 'Shared with me', type: 'sharedWithMe', driveId: null },
        ...sharedDrives.map(d => ({ ...d, type: 'drive', driveId: d.id }))
      ]
    : filtered;

  // Reset selection when navigation or search happens
  $: if (navItems || search) {
    selectedIndex = 0;
  }

  function handleKeydown(e) {
    // If typing in the flow name input, don't navigate the list
    if (showNewFlow && document.activeElement === newFlowInput) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, navItems.length - 1);
      scrollSelectedIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      scrollSelectedIntoView();
    } else if (e.key === 'Enter') {
      const item = navItems[selectedIndex];
      if (item) {
        if (isHome) {
          navigate(item);
        } else {
          clickItem(item);
        }
      }
    } else if (e.key === 'Escape') {
      if (showNewFlow) { cancelNewFlow(); return; }
      if (stack.length > 0) navigateTo(stack.length - 2);
      else launcherOpen.set(false);
    }
  }

  function scrollSelectedIntoView() {
    // Small delay to ensure the DOM has updated classes
    setTimeout(() => {
      const selectedEl = document.querySelector('.file-row.selected');
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 10);
  }
  

  // ── new flow creation ─────────────────────────────────────────────────────
  async function openNewFlowForm() {
    newFlowName   = '';
    newFlowFormat = $launcherNewFormat;  // pre-seeded by template click on home screen
    createError   = '';
    showNewFlow   = true;
    // Load user templates + format links so the dropdown is populated
    if (window.flowkit) {
      [userTemplates, formatLinks] = await Promise.all([
        window.flowkit.getTemplates(),
        window.flowkit.getFormatLinks(),
      ]);
    }
    setTimeout(() => newFlowInput?.focus(), 50);
  }

  function cancelNewFlow() {
    showNewFlow = false;
    createError = '';
  }

  async function submitNewFlow() {
    const name = newFlowName.trim();
    if (!name) { createError = 'name required'; return; }
    if (!loc)  { createError = 'navigate into a folder first'; return; }

    creating    = true;
    createError = '';
    try {
      let file;

      // Path 1: selected format is a user template ID → upload that .xlsx
      const selectedUserTemplate = userTemplates.find(t => t.id === newFlowFormat);

      if (selectedUserTemplate) {
        file = await window.flowkit.createFlowFromTemplate({
          name,
          folderId: loc.id,
          filePath: selectedUserTemplate.filePath,
        });
      } else {
        // Path 2: built-in format has a linked custom template → upload that .xlsx
        const linkedId       = formatLinks[newFlowFormat];
        const linkedTemplate = linkedId ? userTemplates.find(t => t.id === linkedId) : null;

        if (linkedTemplate) {
          file = await window.flowkit.createFlowFromTemplate({
            name,
            folderId: loc.id,
            filePath: linkedTemplate.filePath,
          });
        } else {
          // Path 3: no custom template — use Sheets API with column headers
          file = await window.flowkit.createFlowSheet({
            name,
            folderId: loc.id,
            format:   newFlowFormat,
          });
        }
      }

      await loadLocation(loc);
      showNewFlow = false;
      const url = `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
      currentSheetUrl.set(url);   // update store so the back button appears
      window.flowkit?.openSheet(url);
      launcherOpen.set(false);
    } catch (e) {
      createError = e.message || 'failed to create';
    } finally {
      creating = false;
    }
  }

  function onNewFlowKeydown(e) {
    if (e.key === 'Enter') submitNewFlow();
    if (e.key === 'Escape') cancelNewFlow();
  }

  // ── sign in ───────────────────────────────────────────────────────────────
  async function signIn() {
    if (!window.flowkit) return;
    loading = true;
    error   = '';
    try {
      const result = await window.flowkit.startAuth();
      authState.set({ loggedIn: result.loggedIn, userInfo: result.userInfo });
      if (result.loggedIn) await loadLocation(null);
    } catch (e) {
      error = e.message || 'Sign in failed';
    } finally {
      loading = false;
    }
  }

  async function signOut() {
    if (!window.flowkit) return;
    await window.flowkit.logout();
    authState.set({ loggedIn: false, userInfo: null });
    stack        = [];
    items        = [];
    sharedDrives = [];
    showNewFlow  = false;
  }

  // ── keyboard / overlay ────────────────────────────────────────────────────
  function onOverlayClick(e) {
    if (e.target === e.currentTarget) launcherOpen.set(false);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  onMount(async () => {
    if (!window.flowkit) return;
    const status = await window.flowkit.getAuthStatus();
    authState.set({ loggedIn: status.loggedIn, userInfo: status.userInfo });
    if (status.loggedIn) await loadLocation(null);

    unsubAuth = window.flowkit.onAuthComplete(async (data) => {
      authState.set({ loggedIn: data.loggedIn, userInfo: data.userInfo });
      if (data.loggedIn) { stack = []; await loadLocation(null); }
    });
  });

  onDestroy(() => {
    if (unsubAuth) unsubAuth();
    launcherMode.set('open'); // always reset mode when launcher closes
  });

  
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="overlay" role="dialog" aria-modal="true" tabindex="0" on:click={onOverlayClick}>
  <div class="modal">

    <!-- ── header ──────────────────────────────────────────────────────── -->
    <div class="modal-header">
      {#if stack.length > 0}
        <nav class="breadcrumb" aria-label="Drive navigation">
          <button class="crumb" on:click={() => navigateTo(-1)}>home</button>
          {#each stack as crumb, i}
            <span class="sep">›</span>
            {#if i < stack.length - 1}
              <button class="crumb" on:click={() => navigateTo(i)}>{crumb.name}</button>
            {:else}
              <span class="crumb crumb-current">{crumb.name}</span>
            {/if}
          {/each}
        </nav>
      {:else}
        <span class="modal-title">{$launcherMode === 'new-flow' ? 'select folder for new flow' : 'open sheet'}</span>
      {/if}
      <button class="close-btn" on:click={() => launcherOpen.set(false)} aria-label="Close">✕</button>
    </div>

    <!-- ── body ────────────────────────────────────────────────────────── -->

    {#if !$authState.loggedIn}
      <!-- not signed in -->
      <div class="sign-in-section">
        <p class="hint-text">connect your google account to browse sheets</p>
        <button class="sign-in-btn" on:click={signIn} disabled={loading}>
          {loading ? 'connecting…' : 'connect google drive'}
        </button>
        {#if error}<p class="error-text">{error}</p>{/if}
      </div>

    {:else if loading}
      <div class="state-msg">loading…</div>

    {:else if error}
      <div class="state-msg error-text">{error}</div>

    {:else if isHome}
      <ul class="file-list">
        {#each navItems as item, i}
          {#if item.type === 'drive' && (i === 0 || navItems[i-1].type !== 'drive')}
            <li class="section-sep"><span>shared drives</span></li>
          {/if}

          <li>
            <button 
              class="file-row nav-row"
              class:selected={selectedIndex === i} 
              on:click={() => navigate(item)}
            >
              <span class="row-icon" 
                class:drive-icon={item.type === 'folder' || item.type === 'drive'}
                class:shared-icon={item.type === 'sharedWithMe'}
              >▸</span>
              <span class="file-name">{item.name}</span>
              <span class="chevron">›</span>
            </button>
          </li>
        {/each}
      </ul>

    {:else}
      <div class="search-wrap">
        <input
          bind:this={searchInput}
          type="text"
          class="search-input"
          bind:value={search}
          placeholder="filter…"
          spellcheck="false"
          autocomplete="off"
        />
        {#if loc && loc.type !== 'sharedWithMe'}
          <button class="new-flow-btn" on:click={openNewFlowForm}>
            + new flow
          </button>
        {/if}
      </div>

      {#if showNewFlow}
        <div class="new-flow-form">
          <input
            bind:this={newFlowInput}
            type="text"
            class="nf-input"
            bind:value={newFlowName}
            placeholder="flow name…"
            on:keydown={onNewFlowKeydown}
          />
          <div class="nf-row">
            <select class="nf-select" bind:value={newFlowFormat}>
              <optgroup label="Default formats">
                <option value="Policy">Policy</option>
                <option value="LD">LD</option>
                <option value="PF">PF</option>
              </optgroup>
              {#if userTemplates.length > 0}
                <optgroup label="Custom templates">
                  {#each userTemplates as tmpl}
                    <option value={tmpl.id}>{tmpl.name}</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
            <button class="nf-create" on:click={submitNewFlow} disabled={creating}>
              {creating ? 'creating…' : 'create'}
            </button>
            <button class="nf-cancel" on:click={cancelNewFlow}>cancel</button>
          </div>
          {#if createError}<p class="nf-error">{createError}</p>{/if}
        </div>
      {/if}

      {#if filtered.length === 0}
        <div class="state-msg">{search ? 'no matches' : 'nothing here'}</div>
      {:else}
        <ul class="file-list">
          {#each filtered as item, i}
            <li>
              <button 
                class="file-row" 
                class:nav-row={isFolder(item)} 
                class:selected={selectedIndex === i}
                on:click={() => clickItem(item)}
              >
                <span class="row-icon"
                  class:folder-icon={isFolder(item)}
                  class:sheet-icon={isSheet(item) && !isXlsx(item)}
                  class:xlsx-icon={isXlsx(item)}
                ></span>
                <span class="file-name">{item.name}</span>
                {#if isFolder(item)}
                  <span class="chevron">›</span>
                {:else}
                  <span class="file-date">{relativeDate(item.modifiedTime)}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <!-- ── footer: sign out ──────────────────────────────────────────── -->
    {#if $authState.loggedIn}
      <div class="modal-footer">
        <span class="footer-email">{$authState.userInfo?.email ?? ''}</span>
        <button class="signout-btn" on:click={signOut}>sign out</button>
      </div>
    {/if}

  </div>
</div>

<style>
  /* ── overlay ──────────────────────────────────────────────────────────── */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 200;
    display: flex;
    justify-content: center;
    padding-top: 72px;
  }

  /* ── modal card ───────────────────────────────────────────────────────── */
  .modal {
    background: #111;
    border: 1px solid #252525;
    border-radius: 8px;
    width: 540px;
    max-height: 520px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
    align-self: flex-start;
  }

  /* ── header ───────────────────────────────────────────────────────────── */
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 14px;
    border-bottom: 1px solid #1c1c1c;
    flex-shrink: 0;
    min-height: 42px;
  }

  .modal-title {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #666;
    text-transform: lowercase;
  }

  /* ── breadcrumb ───────────────────────────────────────────────────────── */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    overflow: hidden;
    min-width: 0;
  }

  .crumb {
    background: none;
    border: none;
    color: #5a5a9a;
    font-size: 0.72rem;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    white-space: nowrap;
    transition: color 0.1s;
  }
  .crumb:hover { color: #8888cc; }

  .crumb-current {
    color: #aaa;
    font-size: 0.72rem;
    padding: 2px 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sep {
    color: #333;
    font-size: 0.72rem;
    flex-shrink: 0;
  }

  .close-btn {
    flex-shrink: 0;
    margin-left: 8px;
    background: none;
    border: none;
    color: #444;
    font-size: 0.72rem;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    line-height: 1;
    transition: color 0.12s, background 0.12s;
  }
  .close-btn:hover { color: #ef4444; background: #3f1010; }

  /* ── search ───────────────────────────────────────────────────────────── */
  .search-wrap {
    padding: 8px 10px;
    border-bottom: 1px solid #181818;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .search-input {
    width: 100%;
    background: #0a0a0a;
    border: 1px solid #1e1e1e;
    border-radius: 5px;
    padding: 6px 10px;
    color: #e2e2e2;
    font-size: 0.82rem;
    font-family: inherit;
    outline: none;
    caret-color: #646cff;
    transition: border-color 0.12s;
  }
  .search-input:focus { border-color: #2e2e4e; }
  .search-input::placeholder { color: #333; }

  /* ── file list ────────────────────────────────────────────────────────── */
  .file-list {
    list-style: none;
    overflow-y: auto;
    flex: 1;
    padding: 3px 0;
    scroll-behavior: smooth;
  }
  .file-list li { display: contents; }

  .file-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    /* add a transparent border to prevent layout shifts on selection */
    border-left: 3px solid transparent; 
    background: none;
    border-top: none;
    border-right: none;
    border-bottom: none;
    color: #d0d0d0;
    font-size: 0.82rem;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }

  /* ── the "pro" selection state ────────────────────────────────────────── */
  .file-row.selected {
    background: linear-gradient(90deg, #1a1a2e 0%, #111 100%);
    border-left-color: #646cff; /* matching your caret color */
    color: #ffffff;
    outline: none; /* remove default browser focus ring */
  }

  .file-row.selected .chevron {
    color: #888;
  }

  .file-row.selected .file-date {
    color: #666;
  }

  /* ensure hover and selected play nice together */
  .file-row:hover:not(.selected) { 
    background: #181818; 
    border-left-color: #252525;
  }

  /* navigable rows (folders, drives) */
  .nav-row { color: #aaa; }
  .nav-row:hover, .nav-row.selected { color: #fff; }

  /* ── row icons (CSS squares) ──────────────────────────────────────────── */
  .row-icon {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }

  /* folder = blue-grey square */
  .folder-icon { background: #3a3a6e; }

  /* sheet = Google-Sheets green */
  .sheet-icon { background: #1a5e35; }

  /* xlsx = muted teal to distinguish from native Sheets */
  .xlsx-icon { background: #1a4a5e; }

  /* home-level "drive" icon same as folder */
  .drive-icon { background: #3a3a6e; font-size: 0; }

  /* shared-with-me gets a lighter purple */
  .shared-icon { background: #4a2e6e; font-size: 0; }

  /* ── row right-side elements ─────────────────────────────────────────── */
  .file-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    color: #333;
    font-size: 0.88rem;
    flex-shrink: 0;
    transition: color 0.08s;
  }
  .file-row:hover .chevron { color: #666; }

  .file-date {
    color: #444;
    font-size: 0.7rem;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* ── section separator (Shared Drives label) ─────────────────────────── */
  .section-sep {
    display: block !important;  /* override display:contents from li */
    padding: 8px 14px 4px;
  }
  .section-sep span {
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #333;
  }

  /* ── misc ─────────────────────────────────────────────────────────────── */
  .state-msg {
    padding: 36px 16px;
    text-align: center;
    color: #444;
    font-size: 0.8rem;
  }

  .sign-in-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 36px 24px;
    gap: 16px;
  }

  .hint-text {
    color: #444;
    font-size: 0.8rem;
    text-align: center;
  }

  .sign-in-btn {
    background: #111827;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    color: #8888cc;
    font-size: 0.82rem;
    font-family: inherit;
    padding: 9px 20px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .sign-in-btn:hover:not(:disabled) { background: #161b30; border-color: #3a3a6a; }
  .sign-in-btn:disabled { opacity: 0.5; cursor: default; }

  .error-text { color: #ef4444; font-size: 0.75rem; }

  /* ── modal footer ────────────────────────────────────────────────────────── */
  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-top: 1px solid #1a1a1a;
    flex-shrink: 0;
  }

  .footer-email {
    color: #3a3a5a;
    font-size: 0.68rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .signout-btn {
    background: none;
    border: none;
    color: #3a3a5a;
    font-size: 0.68rem;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 4px;
    transition: color 0.12s;
    flex-shrink: 0;
  }
  .signout-btn:hover { color: #ef4444; }

  /* ── search row with new flow button ────────────────────────────────────── */
  .search-wrap .search-input { flex: 1; }

  .new-flow-btn {
    flex-shrink: 0;
    background: none;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    color: #6666bb;
    font-size: 0.72rem;
    font-family: inherit;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .new-flow-btn:hover { border-color: #4444aa; color: #9999dd; background: #111827; }

  /* ── new flow form ───────────────────────────────────────────────────────── */
  .new-flow-form {
    padding: 10px 10px 6px;
    border-bottom: 1px solid #181818;
    background: #0d0d1a;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .nf-input {
    width: 100%;
    background: #0a0a0a;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    padding: 6px 10px;
    color: #e2e2e2;
    font-size: 0.82rem;
    font-family: inherit;
    outline: none;
    caret-color: #646cff;
    transition: border-color 0.12s;
    box-sizing: border-box;
  }
  .nf-input:focus { border-color: #4444aa; }
  .nf-input::placeholder { color: #333; }

  .nf-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .nf-select {
    background: #0a0a0a;
    border: 1px solid #252535;
    border-radius: 4px;
    color: #aaa;
    font-size: 0.78rem;
    font-family: inherit;
    padding: 4px 8px;
    outline: none;
    cursor: pointer;
  }
  .nf-select:focus { border-color: #3a3a6a; }

  .nf-create {
    background: #111827;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    color: #8888cc;
    font-size: 0.78rem;
    font-family: inherit;
    padding: 4px 14px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .nf-create:hover:not(:disabled) { background: #161b30; border-color: #4a4aaa; color: #aaaaee; }
  .nf-create:disabled { opacity: 0.45; cursor: default; }

  .nf-cancel {
    background: none;
    border: none;
    color: #444;
    font-size: 0.78rem;
    font-family: inherit;
    padding: 4px 8px;
    cursor: pointer;
    transition: color 0.12s;
  }
  .nf-cancel:hover { color: #888; }

  .nf-error {
    color: #ef4444;
    font-size: 0.72rem;
    margin: 0;
  }
</style>
