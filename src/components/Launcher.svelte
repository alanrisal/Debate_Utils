<script>
  import { onMount, onDestroy } from 'svelte';
  import { launcherOpen } from '../stores/uiState.js';
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
    // Focus the search box after navigating into a folder
    if (searchInput) setTimeout(() => searchInput?.focus(), 50);
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

  // ── keyboard / overlay ────────────────────────────────────────────────────
  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (stack.length > 0) navigateTo(stack.length - 2);
      else launcherOpen.set(false);
    }
  }

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

  onDestroy(() => { if (unsubAuth) unsubAuth(); });
</script>

<svelte:window on:keydown={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="overlay" role="dialog" aria-modal="true" on:click={onOverlayClick}>
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
        <span class="modal-title">open sheet</span>
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
      <!-- ── home view ──────────────────────────────────────────────── -->
      <ul class="file-list">
        <li>
          <button class="file-row nav-row"
            on:click={() => navigate({ id: 'root', name: 'My Drive', type: 'folder', driveId: null })}>
            <span class="row-icon drive-icon">▸</span>
            <span class="file-name">My Drive</span>
            <span class="chevron">›</span>
          </button>
        </li>
        <li>
          <button class="file-row nav-row"
            on:click={() => navigate({ id: 'sharedWithMe', name: 'Shared with me', type: 'sharedWithMe', driveId: null })}>
            <span class="row-icon shared-icon">▸</span>
            <span class="file-name">Shared with me</span>
            <span class="chevron">›</span>
          </button>
        </li>

        {#if sharedDrives.length > 0}
          <li class="section-sep"><span>shared drives</span></li>
          {#each sharedDrives as drive (drive.id)}
            <li>
              <button class="file-row nav-row"
                on:click={() => navigate({ id: drive.id, name: drive.name, type: 'drive', driveId: drive.id })}>
                <span class="row-icon drive-icon">▸</span>
                <span class="file-name">{drive.name}</span>
                <span class="chevron">›</span>
              </button>
            </li>
          {/each}
        {/if}
      </ul>

    {:else}
      <!-- ── folder / sharedWithMe view ───────────────────────────────── -->
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
      </div>

      {#if filtered.length === 0}
        <div class="state-msg">{search ? 'no matches' : 'nothing here'}</div>
      {:else}
        <ul class="file-list">
          {#each filtered as item (item.id)}
            <li>
              <button class="file-row" class:nav-row={isFolder(item)} on:click={() => clickItem(item)}>
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
  }
  .file-list li { display: contents; }

  .file-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    background: none;
    border: none;
    color: #d0d0d0;
    font-size: 0.82rem;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.08s;
  }
  .file-row:hover { background: #181818; }

  /* navigable rows (folders, drives) are slightly dimmer by default */
  .nav-row { color: #aaa; }
  .nav-row:hover { color: #d0d0d0; }

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
</style>
