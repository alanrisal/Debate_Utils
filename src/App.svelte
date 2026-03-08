<script>
  import { onMount, tick } from 'svelte';
  import Toolbar    from './components/Toolbar.svelte';
  import Launcher   from './components/Launcher.svelte';
  import Home       from './components/Home.svelte';
  import BlockPanel from './components/BlockPanel.svelte';
  import Toast      from './lib/alert.svelte';
  import { launcherOpen, sidebarView } from './stores/uiState.js';
  import { currentSheetUrl } from './stores/sheetState.js';
  import { authState } from './stores/auth.js';
  import { showToast } from './stores/toast.js';

  let blockPanel = null;   // bound to BlockPanel for focusSearch()

  // Auto-switch view when the active tab changes.
  // Opening a sheet → kit view.  Closing it / navigating away → home view.
  // The user can also manually toggle with toolbar buttons / palette command.
  let _prevUrl = '';
  $: {
    if ($currentSheetUrl && !_prevUrl) sidebarView.set('kit');
    if (!$currentSheetUrl)             sidebarView.set('home');
    _prevUrl = $currentSheetUrl;
  }

  onMount(() => {
    window.flowkit?.parseAllTubs?.();

    // Sync the current Sheets tab URL into the store on sidebar open.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs?.[0]?.url || '';
      if (url.includes('docs.google.com/spreadsheets')) currentSheetUrl.set(url);
    });

    function onTabUpdate(tabId, info, tab) {
      if (info.status !== 'complete') return;
      chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
        if (activeTabs[0]?.id !== tabId) return;
        const url = tab.url || '';
        currentSheetUrl.set(url.includes('docs.google.com/spreadsheets') ? url : '');
      });
    }
    function onTabActivated() {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = tabs?.[0]?.url || '';
        currentSheetUrl.set(url.includes('docs.google.com/spreadsheets') ? url : '');
      });
    }

    chrome.tabs.onUpdated.addListener(onTabUpdate);
    chrome.tabs.onActivated.addListener(onTabActivated);

    // Focus the block search input (Ctrl+. shortcut from Toolbar).
    const unsubFocus = window.flowkit.onPanelFocusSearch(async () => {
      if ($sidebarView !== 'kit') {
        sidebarView.set('kit');
        await tick();
      }
      await tick();
      blockPanel?.focusSearch();
    });

    const unsubAuth = window.flowkit.onAuthComplete(async (data) => {
      authState.set({ loggedIn: data.loggedIn, userInfo: data.userInfo });
      if (data.loggedIn) showToast('Signed in to Google', 'success', 3000);
    });

    return () => {
      chrome.tabs.onUpdated.removeListener(onTabUpdate);
      chrome.tabs.onActivated.removeListener(onTabActivated);
      unsubFocus();
      unsubAuth();
    };
  });
</script>

<div class="shell">
  <Toolbar />

  <!-- Full-width content area: either the block panel (kit) or the home screen -->
  <main class="content">
    {#if $sidebarView === 'kit'}
      <BlockPanel bind:this={blockPanel} />
    {:else}
      <Home />
    {/if}
  </main>

  {#if $launcherOpen}
    <Launcher />
  {/if}

  <Toast />
</div>

<style>
  .shell {
    width: 100%;
    height: 100vh;
    overflow: hidden;
    background: var(--bg, #0e0e0e);
    display: flex;
    flex-direction: column;
  }

  /* Content area fills all space below the fixed toolbar */
  .content {
    position: fixed;
    top: var(--toolbar-h, 72px);
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
