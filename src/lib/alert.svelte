<script>
  import { fly } from 'svelte/transition';
  import { toast } from '../stores/toast.js';
</script>

{#if $toast}
  <div
    class="toast-strip"
    role="alert"
    aria-live="assertive"
    transition:fly={{ y: -28, duration: 160 }}
  >
    <span class="toast-msg">{$toast.message}</span>
  </div>
{/if}

<style>
  .toast-strip {
    position: fixed;
    top: var(--toolbar-h, 72px); /* sits flush below the toolbar */
    left: 0;
    right: 0;
    height: 28px;
    background: #0d0505;
    border-bottom: 1px solid #7f1d1d;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    pointer-events: none;
  }

  .toast-msg {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    color: #f87171;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 90%;
  }
</style>
