<script>
  import { currentSheetUrl } from '../stores/sheetState.js';
  import { authState } from '../stores/auth.js';
  import { launcherOpen } from '../stores/uiState.js';

  let inputValue = '';
  let error = '';

  function openSheet() {
    const url = inputValue.trim();
    if (!url) return;

    if (!url.includes('docs.google.com/spreadsheets')) {
      error = 'paste a google sheets URL';
      setTimeout(() => (error = ''), 2000);
      return;
    }

    error = '';
    currentSheetUrl.set(url);
    window.flowkit?.openSheet(url);
  }

  function onKeydown(e) {
    if (e.key === 'Enter') openSheet();
    if (e.key === 'Escape') {
      inputValue = '';
      error = '';
      e.currentTarget.blur();
    }
  }

  function truncateEmail(email) {
    if (!email) return '';
    if (email.length <= 22) return email;
    const [local, domain] = email.split('@');
    return local.slice(0, 10) + '…@' + domain;
  }
</script>

<header class="toolbar">
  <span class="logo">flowkit</span>

  <div class="url-bar-wrap">
    <input
      type="text"
      class="url-bar"
      class:error
      bind:value={inputValue}
      on:keydown={onKeydown}
      placeholder="paste a Google Sheets URL and press Enter…"
      spellcheck="false"
      autocomplete="off"
    />
    {#if error}
      <span class="error-msg">{error}</span>
    {/if}
  </div>

  <!-- Drive button / auth status -->
  <button
    class="drive-btn"
    class:connected={$authState.loggedIn}
    on:click={() => launcherOpen.set(true)}
    aria-label={$authState.loggedIn ? 'Open Drive file picker' : 'Connect Google Drive'}
    title={$authState.loggedIn && $authState.userInfo ? $authState.userInfo.email : ''}
  >
    {#if $authState.loggedIn && $authState.userInfo}
      <span class="user-email">{truncateEmail($authState.userInfo.email)}</span>
    {:else}
      <span>connect drive</span>
    {/if}
  </button>

  <span class="hint">
    <kbd>ctrl</kbd><kbd>k</kbd> blocks
  </span>

  <button class="close-btn" on:click={() => window.flowkit?.closeWindow()} aria-label="Close">
    ✕
  </button>
</header>

<style>
  .toolbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--toolbar-h);
    background: var(--toolbar-bg);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    z-index: 100;
    -webkit-app-region: drag;
  }

  /* ── Logo ── */
  .logo {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--subtext);
    text-transform: lowercase;
    flex-shrink: 0;
    -webkit-app-region: no-drag;
  }

  /* ── URL bar ── */
  .url-bar-wrap {
    flex: 1;
    position: relative;
    -webkit-app-region: no-drag;
  }

  .url-bar {
    width: 100%;
    background: #0a0a0a;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 5px 10px;
    color: var(--text);
    font-size: 0.78rem;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    outline: none;
    transition: border-color 0.15s;
    caret-color: var(--accent);
  }

  .url-bar:focus {
    border-color: var(--muted);
  }

  .url-bar.error {
    border-color: #7f1d1d;
  }

  .url-bar::placeholder {
    color: var(--muted);
    font-family: inherit;
  }

  .error-msg {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.68rem;
    color: #ef4444;
    pointer-events: none;
  }

  /* ── Drive button ── */
  .drive-btn {
    flex-shrink: 0;
    background: #111;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--muted);
    font-size: 0.72rem;
    font-family: inherit;
    padding: 4px 10px;
    height: 28px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
    white-space: nowrap;
    -webkit-app-region: no-drag;
  }

  .drive-btn:hover {
    border-color: #3a3a3a;
    color: var(--text);
    background: #1a1a1a;
  }

  .drive-btn.connected {
    border-color: #2a2a4a;
    color: #9090ff;
    background: #0d0d1e;
  }

  .drive-btn.connected:hover {
    border-color: #3a3a6a;
    background: #141428;
  }

  .user-email {
    font-size: 0.7rem;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Keyboard hint ── */
  .hint {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    color: var(--muted);
    font-size: 0.68rem;
    -webkit-app-region: no-drag;
  }

  kbd {
    background: #1e1e1e;
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 0.65rem;
    font-family: inherit;
    color: var(--muted);
  }

  /* ── Close button ── */
  .close-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
    -webkit-app-region: no-drag;
  }

  .close-btn:hover {
    background: #3f1010;
    color: #ef4444;
  }
</style>
