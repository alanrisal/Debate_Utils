<script>
  import { onMount } from 'svelte';
  import { blocks, activeTubId, loadTub } from '../stores/blockIndex.js';
  import { search } from '../lib/search.js';

  const isMac = typeof window !== 'undefined' && window.flowkit?.platform === 'darwin';

  // ── Tub registry ──────────────────────────────────────────────────────────
  let tubs        = [];
  let loadingTub  = false;
  let loadError   = '';

  onMount(async () => {
    if (!window.flowkit) return;
    tubs = (await window.flowkit.getTubs()) ?? [];
  });

  async function selectTub(id) {
    if (!id) return;
    loadingTub = true;
    loadError  = '';
    try {
      await loadTub(id);
    } catch (e) {
      loadError = e.message || 'failed to load';
    } finally {
      loadingTub = false;
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────
  let query       = '';
  let selectedIdx = 0;
  let searchInput = null;   // bound to the <input> element

  // Called by App.svelte when Ctrl+. fires — focuses the search box so the
  // user can type without clicking away from the sheet.
  export function focusSearch() {
    searchInput?.focus();
  }

  $: results = query.trim() ? search(query.trim(), 12) : [];
  $: if (results) selectedIdx = 0;  // reset on every new result set

  // ── Injection ─────────────────────────────────────────────────────────────
  let injecting  = false;
  let flashId    = null;   // id of the block that just injected (for flash)

  async function inject(block) {
    if (!block || injecting || !window.flowkit?.injectBlock) return;
    injecting = true;
    flashId   = block.id;
    try {
      await window.flowkit.injectBlock(block.content);
      // Clear search so user is ready for the next argument immediately.
      query       = '';
      selectedIdx = 0;
    } finally {
      injecting = false;
      setTimeout(() => { flashId = null; }, 500);
    }
  }

  // ── Keyboard handling (on the search input) ───────────────────────────────
  function onKeydown(e) {
    // 1–5: inject the nth visible result without adding the digit to the input
    const n = parseInt(e.key);
    if (n >= 1 && n <= 5 && results[n - 1]) {
      e.preventDefault();
      inject(results[n - 1]);
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, results.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIdx]) inject(results[selectedIdx]);
        break;
      case 'Escape':
        query       = '';
        selectedIdx = 0;
        break;
    }
  }

  // ── Score display ─────────────────────────────────────────────────────────
  function scoreClass(s) {
    if (s >= 85) return 'score-hi';
    if (s >= 60) return 'score-mid';
    return 'score-lo';
  }
</script>

<!-- ── Tub selector header ─────────────────────────────────────────────────── -->
<div class="header">
  <select
    class="tub-select"
    value={$activeTubId ?? ''}
    on:change={(e) => selectTub(e.target.value)}
    disabled={loadingTub}
  >
    <option value="" disabled>select block file…</option>
    {#each tubs as tub}
      <option value={tub.id}>{tub.name}</option>
    {/each}
  </select>

  {#if $blocks.length}
    <span class="block-count">{$blocks.length}</span>
  {:else if !tubs.length}
    <span class="no-tubs">add .docx in settings</span>
  {/if}
</div>

<!-- ── Search input ────────────────────────────────────────────────────────── -->
<div class="search-row" class:dim={loadingTub}>
  <span class="prompt">$</span>
  <input
    class="search-input"
    type="text"
    bind:this={searchInput}
    bind:value={query}
    on:keydown={onKeydown}
    placeholder={
      loadingTub ? 'loading…' :
      loadError  ? loadError  :
      $blocks.length ? 'search blocks…' :
      tubs.length    ? 'select a file above' :
      'no block files loaded'
    }
    disabled={loadingTub || !$blocks.length}
    spellcheck="false"
    autocomplete="off"
  />
</div>

<!-- ── Results list ────────────────────────────────────────────────────────── -->
<div class="results-wrap">
  {#if results.length > 0}
    <ul class="results">
      {#each results as block, i}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <li
          class="result"
          class:selected={i === selectedIdx}
          class:flash={block.id === flashId}
          on:click={() => inject(block)}
          on:mouseenter={() => (selectedIdx = i)}
          role="option"
          aria-selected={i === selectedIdx}
        >
          <div class="result-top">
            {#if i < 5}
              <span class="key">{i + 1}</span>
            {:else}
              <span class="key dim">·</span>
            {/if}
            <span class="block-name">{block.block}</span>
            <span class="score {scoreClass(block.score)}">{block.score}</span>
          </div>
          <div class="result-sub">
            {block.hat} · {block.pocket}
            {#if block.matchSource === 'content'}
              <span class="content-tag">~content</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else if query.trim() && $blocks.length}
    <div class="empty">no matches</div>
  {:else if !$blocks.length && !loadingTub}
    <div class="empty">
      {tubs.length ? 'select a block file to begin' : 'add .docx block files in settings'}
    </div>
  {/if}
</div>

<!-- ── Footer ─────────────────────────────────────────────────────────────── -->
<div class="footer">
  <span>1–5 inject</span>
  <span class="sep">·</span>
  <span>↑↓ navigate</span>
  <span class="sep">·</span>
  <span>esc clear</span>
  <span class="sep">·</span>
  <span>{isMac ? 'cmd+k' : 'ctrl+k'} close</span>
</div>

<style>
  /* The panel itself is positioned by App.svelte; we just fill it. */
  :global(.panel) {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ───────────────────────────────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .tub-select {
    flex: 1;
    min-width: 0;
    background: #0a0a0a;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 10px;
    padding: 3px 6px;
    outline: none;
    cursor: pointer;
  }
  .tub-select:focus { border-color: var(--border-hover); }
  .tub-select:disabled { opacity: 0.5; cursor: default; }

  .block-count {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 9px;
    color: var(--subtext);
    flex-shrink: 0;
    letter-spacing: 0.04em;
  }

  .no-tubs {
    font-size: 9px;
    color: var(--muted);
    flex-shrink: 0;
  }

  /* ── Search ───────────────────────────────────────────────────────────── */
  .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  .search-row.dim { opacity: 0.4; }

  .prompt {
    color: var(--subtext);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
    caret-color: #ffffff;
  }
  .search-input::placeholder {
    color: var(--muted);
    font-size: 10px;
  }
  .search-input:disabled { cursor: default; }

  /* ── Results ──────────────────────────────────────────────────────────── */
  .results-wrap {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .results {
    list-style: none;
    padding: 3px 0;
  }

  .result {
    display: block;
    width: 100%;
    padding: 7px 10px 5px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.08s, border-color 0.08s;
    text-align: left;
  }
  .result:hover:not(.selected) { background: #181818; }
  .result.selected {
    background: #141422;
    border-left-color: #5555cc;
  }
  .result.flash {
    background: #1a2a1a;
    border-left-color: #44aa44;
  }

  .result-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .key {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 9px;
    color: #4444aa;
    background: #0d0d1a;
    border: 1px solid #252545;
    border-radius: 2px;
    padding: 0 3px;
    flex-shrink: 0;
    line-height: 1.6;
  }
  .key.dim { color: var(--muted); background: none; border-color: transparent; }
  .result.selected .key { color: #7777dd; border-color: #3a3a66; }

  .block-name {
    flex: 1;
    font-size: 11px;
    color: var(--text);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result.selected .block-name { color: #ffffff; }

  .score {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 9px;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }
  .score-hi  { color: #44aa66; }
  .score-mid { color: #aa8844; }
  .score-lo  { color: var(--muted); }

  .result-sub {
    font-size: 9px;
    color: var(--subtext);
    margin-top: 2px;
    padding-left: 22px;   /* align under block-name, past the key badge */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .content-tag {
    font-size: 8px;
    color: #444466;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  /* ── Empty states ─────────────────────────────────────────────────────── */
  .empty {
    padding: 28px 12px;
    font-size: 10px;
    color: var(--muted);
    text-align: center;
    line-height: 1.6;
  }

  /* ── Footer ───────────────────────────────────────────────────────────── */
  .footer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 0.03em;
  }
  .sep { color: #222; }
</style>
