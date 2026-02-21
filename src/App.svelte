<script>
  import { onMount } from 'svelte';
  import Toolbar  from './components/Toolbar.svelte';
  import Launcher from './components/Launcher.svelte';
  import Home     from './components/Home.svelte';
  import { launcherOpen } from './stores/uiState.js';
  import { currentSheetUrl } from './stores/sheetState.js';

  let panelOpen = false;

  onMount(() => {
    if (!window.flowkit) return;

    // Main process sends this when Ctrl+K is pressed.
    const unsubPanel = window.flowkit.onPanelToggle((isOpen) => {
      panelOpen = isOpen;
    });

    // Keep the native sheet view in sync with the launcher open/closed state.
    // The sheet view (WebContentsView) sits above Svelte content in the OS layer,
    // so main must move it off-screen whenever our Svelte overlay is visible.
    const unsubLauncher = launcherOpen.subscribe((isOpen) => {
      window.flowkit.toggleLauncher(isOpen);
    });

    return () => {
      unsubPanel();
      unsubLauncher();
    };
  });
</script>

<div class="shell">
  <Toolbar />

  <!-- The WebContentsView (Google Sheet) renders beneath this layer,
       positioned by main.cjs to start at --toolbar-h px from the top.
       This div fills that same space so clicks pass through to the sheet. -->
  <div class="sheet-area" aria-hidden="true" />

  {#if panelOpen}
    <aside class="panel">
      <!-- BlockPanel.svelte will live here in the next phase -->
      <div class="panel-placeholder">
        <span>block panel</span>
        <span class="sub">coming soon — ctrl+k to toggle</span>
      </div>
    </aside>
  {/if}

  {#if !$currentSheetUrl}
    <Home />
  {/if}

  {#if $launcherOpen}
    <Launcher />
  {/if}
</div>

<style>
  .shell {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: transparent;
  }

  /* Transparent click-through region for the embedded sheet */
  .sheet-area {
    position: fixed;
    top: var(--toolbar-h);
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
  }

  /* Block panel — fixed right column, above the sheet view */
  .panel {
    position: fixed;
    top: var(--toolbar-h);
    right: 0;
    width: var(--panel-w);
    bottom: 0;
    background: var(--panel-bg);
    border-left: 1px solid var(--border);
    z-index: 50;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 6px;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .sub {
    font-size: 0.68rem;
    color: #2a2a2a;
  }
</style>
