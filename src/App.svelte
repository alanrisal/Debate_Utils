<script>
  import { onMount, tick } from 'svelte';
  import Toolbar     from './components/Toolbar.svelte';
  import Launcher    from './components/Launcher.svelte';
  import Home        from './components/Home.svelte';
  import BlockPanel  from './components/BlockPanel.svelte';
  import { launcherOpen, panelOpen } from './stores/uiState.js';

  let blockPanel = null;   // bound to BlockPanel instance for focusSearch()
  import { currentSheetUrl } from './stores/sheetState.js';

  onMount(() => {
    if (!window.flowkit) return;

    // Warm up the tub cache in the background so the panel loads instantly.
    window.flowkit.parseAllTubs?.();

    // Main process sends this when Ctrl+K is pressed or the toolbar button fires.
    const unsubPanel = window.flowkit.onPanelToggle((isOpen) => {
      panelOpen.set(isOpen);
    });

    // Ctrl+. — open panel if needed then immediately focus the search input.
    const unsubFocus = window.flowkit.onPanelFocusSearch(async () => {
      if (!$panelOpen) panelOpen.set(true);
      await tick();   // wait for BlockPanel to mount if it just became visible
      blockPanel?.focusSearch();
    });

    // Keep the native sheet view in sync with the launcher open/closed state.
    // The sheet view (WebContentsView) sits above Svelte content in the OS layer,
    // so main must move it off-screen whenever our Svelte overlay is visible.
    const unsubLauncher = launcherOpen.subscribe((isOpen) => {
      window.flowkit.toggleLauncher(isOpen);
    });

    return () => {
      unsubPanel();
      unsubFocus();
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

  {#if $panelOpen}
    <aside class="panel">
      <BlockPanel bind:this={blockPanel} />
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

</style>
