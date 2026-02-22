<script>
  import { onMount } from 'svelte';
  import { launcherOpen, launcherNewFormat } from '../stores/uiState.js';

  // ── Default built-in templates ─────────────────────────────────────────────
  const DEFAULT_TEMPLATES = [
    {
      id: 'policy',
      name: 'Policy',
      format: 'Policy',
      columns: ['1AC', 'CX', '2NC', 'CX', '1AR', '2NR', '2AR'],
    },
    {
      id: 'ld',
      name: 'LD',
      format: 'LD',
      columns: ['AC', 'CX', 'NC', 'CX', '1AR', 'NR', '2AR'],
    },
    {
      id: 'pf',
      name: 'PF',
      format: 'PF',
      columns: ['Pro Case', 'Con Case', 'Rebuttal', 'Summary', 'FF'],
    },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let userTemplates = [];
  let tubs          = [];
  let formatLinks   = { Policy: null, LD: null, PF: null };

  onMount(async () => {
    if (!window.flowkit) return;
    [userTemplates, tubs, formatLinks] = await Promise.all([
      window.flowkit.getTemplates(),
      window.flowkit.getTubs(),
      window.flowkit.getFormatLinks(),
    ]);
  });

  // ── Format linking ─────────────────────────────────────────────────────────
  async function setFormatLink(format, templateId) {
    formatLinks = await window.flowkit.setFormatLink(format, templateId ?? null);
  }

  function linkedTemplate(format) {
    const id = formatLinks[format];
    return id ? userTemplates.find(t => t.id === id) : null;
  }

  // ── Templates ──────────────────────────────────────────────────────────────
  function useTemplate(tmpl) {
    launcherNewFormat.set(tmpl.format);
    launcherOpen.set(true);
  }

  async function addTemplate() {
    if (!window.flowkit) return;
    const tmpl = await window.flowkit.addTemplate();
    if (tmpl) userTemplates = [...userTemplates, tmpl];
  }

  async function removeTemplate(id) {
    if (!window.flowkit) return;
    await window.flowkit.removeTemplate(id);
    userTemplates = userTemplates.filter(t => t.id !== id);
  }

  // ── Tubs ───────────────────────────────────────────────────────────────────
  async function addTub() {
    if (!window.flowkit) return;
    const added = await window.flowkit.addTub();
    if (added?.length) tubs = [...tubs, ...added];
  }

  async function removeTub(id) {
    if (!window.flowkit) return;
    await window.flowkit.removeTub(id);
    tubs = tubs.filter(t => t.id !== id);
  }
</script>

<div class="home">
  <div class="bin-grid">

    <!-- ── Templates Bin ─────────────────────────────────────────────────── -->
    <section class="bin">
      <div class="bin-header">
        <span class="bin-title">templates</span>
        <button class="bin-add-btn" on:click={addTemplate}>+ add</button>
      </div>
      <div class="bin-body">

        <div class="section-label">default</div>
        <div class="tcard-list">
          {#each DEFAULT_TEMPLATES as tmpl}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div class="tcard" on:click={() => useTemplate(tmpl)}>
              <div class="tcard-top">
                <span class="tcard-name">{tmpl.name}</span>
                <span class="tcard-action">use →</span>
              </div>

              <!-- Column chips — hidden when a custom template is linked -->
              {#if !linkedTemplate(tmpl.format)}
                <div class="tcard-cols">
                  {#each tmpl.columns as col}
                    <span class="col-chip">{col}</span>
                  {/each}
                </div>
              {/if}

              <!-- Format link control -->
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <div class="tcard-link" on:click|stopPropagation>
                {#if linkedTemplate(tmpl.format)}
                  {@const linked = linkedTemplate(tmpl.format)}
                  <div class="link-active">
                    <span class="link-icon">↳</span>
                    <span class="link-name">{linked.name}</span>
                    <button class="link-unlink" on:click={() => setFormatLink(tmpl.format, null)} title="Remove link">×</button>
                  </div>
                {:else if userTemplates.length > 0}
                  <select
                    class="link-select"
                    value={formatLinks[tmpl.format] ?? ''}
                    on:change={(e) => { if (e.target.value) setFormatLink(tmpl.format, e.target.value); }}
                  >
                    <option value="" disabled>link custom template…</option>
                    {#each userTemplates as ut}
                      <option value={ut.id}>{ut.name}</option>
                    {/each}
                  </select>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if userTemplates.length > 0}
          <div class="section-label" style="margin-top: 24px;">custom</div>
          {#each userTemplates as tmpl}
            <div class="file-row">
              <span class="file-dot tmpl-dot"></span>
              <span class="file-name">{tmpl.name}</span>
              <button class="remove-btn" on:click={() => removeTemplate(tmpl.id)} title="Remove">×</button>
            </div>
          {/each}
        {/if}

      </div>
    </section>

    <div class="bin-sep"></div>

    <!-- ── Tubs Bin ──────────────────────────────────────────────────────── -->
    <section class="bin">
      <div class="bin-header">
        <span class="bin-title">tubs</span>
        <button class="bin-add-btn" on:click={addTub}>+ add</button>
      </div>
      <div class="bin-body">

        {#if tubs.length === 0}
          <div class="empty-state">
            <span class="empty-main">no files loaded</span>
            <span class="empty-sub">add .docx block files — 1AR, blocks, answers</span>
          </div>
        {:else}
          {#each tubs as tub}
            <div class="file-row tub-row">
              <span class="file-dot tub-dot"></span>
              <div class="file-info">
                <span class="file-name">{tub.name}</span>
                <span class="file-path">{tub.filePath}</span>
              </div>
              <button class="remove-btn" on:click={() => removeTub(tub.id)} title="Remove">×</button>
            </div>
          {/each}
        {/if}

      </div>
    </section>

  </div>
</div>

<style>
  :root {
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

    /* Minimalist White System */
    --text-white: #e6e6e6;
    --text-white-dim: #bfbfbf;
    --text-white-faint: #8a8a8a;
  }

  .home {
    position: fixed;
    top: 46px;
    left: 0;
    right: 0;
    bottom: 0;
    background: #0a0a0a;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--font-mono);
    color: var(--text-white);
  }

  .bin-grid {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .bin {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 1;
  }

  .bin-sep {
    width: 1px;
    background: #141414;
    flex-shrink: 0;
  }

  .bin-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 26px 14px;
    border-bottom: 1px solid #111;
    flex-shrink: 0;
  }

  .bin-title {
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-white);
  }

  .bin-add-btn {
    background: none;
    border: 1px solid #1c1c1c;
    border-radius: 3px;
    color: var(--text-white-dim);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    padding: 4px 12px;
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }

  .bin-add-btn:hover {
    border-color: #2a2a2a;
    color: var(--text-white);
  }

  .bin-body {
    flex: 1;
    overflow-y: auto;
    padding: 22px 26px;
    scrollbar-width: thin;
    scrollbar-color: #1a1a1a transparent;
  }

  .section-label {
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-white-dim);
    margin-bottom: 14px;
  }

  .tcard-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .tcard {
  padding: 14px 16px;
  background: #0d0d0d;
  border: 1px solid #161616;
  border-radius: 6px;
  cursor: pointer;
  transition:
    transform 0.18s cubic-bezier(.2,.8,.2,1),
    border-color 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
}

.tcard:hover {
  transform: translateY(-2px);
  border-color: #2a2a2a;
  background: #111;
  box-shadow:
    0 6px 20px rgba(0,0,0,0.6),
    inset 0 1px 0 rgba(255,255,255,0.03);
}


  .tcard-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .tcard-name {
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-white);
  }

  .tcard-action {
    font-size: 0.74rem;
    color: var(--text-white-dim);
    transition: color 0.14s;
  }

  .tcard-name {
  transition: letter-spacing 0.2s ease, opacity 0.2s ease;
}

.tcard:hover .tcard-name {
  letter-spacing: 0.08em;
  opacity: 0.95;
}

  .tcard:hover .tcard-action {
    color: var(--text-white);
  }

  .tcard-cols {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .col-chip {
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    color: var(--text-white-dim);
    background: #0a0a0a;
    border: 1px solid #181818;
    border-radius: 2px;
    padding: 3px 8px;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    background: #0c0c0c;
    border: 1px solid #131313;
    border-radius: 3px;
    margin-bottom: 6px;
  }

  .tub-row {
    align-items: flex-start;
  }

  .file-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 1px;
    margin-top: 2px;
  }

  .tmpl-dot { background: #1f1f1f; }
  .tub-dot  { background: #2a2a2a; }

  .file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .file-name {
    font-size: 0.86rem;
    color: var(--text-white);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-path {
    font-size: 0.7rem;
    color: var(--text-white-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .remove-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-white-faint);
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
    padding: 1px 4px;
    font-family: var(--font-mono);
    transition: color 0.12s;
  }

  .remove-btn:hover {
    color: #ef4444;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 40px 0 0;
  }

  .empty-main {
    font-size: 0.84rem;
    color: var(--text-white);
  }

  .empty-sub {
    font-size: 0.72rem;
    color: var(--text-white-faint);
    line-height: 1.5;
  }

  /* ───────────────────────────────────────────── */
/* Premium Interaction Enhancements */
/* ───────────────────────────────────────────── */


/* 1️⃣ Animated "use →" Slide-In */
.tcard-action {
  opacity: 0.4;
  transform: translateX(-6px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.tcard:hover .tcard-action {
  opacity: 1;
  transform: translateX(0);
}


/* 2️⃣ Click Feedback */
.tcard:active {
  transform: translateY(0);
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
}


/* 3️⃣ Interactive File Rows */
.file-row {
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    transform 0.12s ease,
    box-shadow 0.15s ease;
}

.file-row:hover {
  background: #111;
  border-color: #1f1f1f;
  transform: translateX(2px);
  box-shadow: 0 4px 14px rgba(0,0,0,0.5);
}


/* 4️⃣ Premium Scrollbar */
.bin-body::-webkit-scrollbar {
  width: 6px;
}

.bin-body::-webkit-scrollbar-thumb {
  background: #1f1f1f;
  border-radius: 4px;
  transition: background 0.15s ease;
}

.bin-body::-webkit-scrollbar-thumb:hover {
  background: #2a2a2a;
}


/* Firefox */
.bin-body {
  scrollbar-width: thin;
  scrollbar-color: #1f1f1f transparent;
}


/* 5️⃣ Micro-Glow Under Section Titles */
.bin-title {
  position: relative;
}

.bin-title::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -6px;
  width: 24px;
  height: 1px;
  background: linear-gradient(to right, rgba(255,255,255,0.15), transparent);
}


/* 6️⃣ Global Ambient Glow */
.home::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(
      circle at 50% -20%,
      rgba(255,255,255,0.03),
      transparent 60%
    );
}


/* 7️⃣ Empty State Refinement */
.empty-main {
  letter-spacing: 0.08em;
  opacity: 0.85;
}

.empty-sub {
  opacity: 0.5;
}


/* 8️⃣ Remove-Button Micro Interaction */
.remove-btn {
  transition: color 0.12s ease, transform 0.12s ease;
}

.remove-btn:hover {
  transform: scale(1.15);
}


/* 9️⃣ Subtle Focus Ring for Keyboard Users */
.tcard:focus-visible,
.file-row:focus-visible,
.bin-add-btn:focus-visible,
.remove-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.2);
}


/* 🔟 Reduced Motion Support */
@media (prefers-reduced-motion: reduce) {
  .tcard,
  .file-row,
  .tcard-action,
  .remove-btn {
    transition: none;
  }
}

/* ── Format link controls ────────────────────────────────────────────────────── */
.tcard-link {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #161616;
}

.link-active {
  display: flex;
  align-items: center;
  gap: 6px;
}

.link-icon {
  font-size: 0.74rem;
  color: #5a5a9a;
}

.link-name {
  flex: 1;
  font-size: 0.74rem;
  color: #7a7aaa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.link-unlink {
  background: none;
  border: none;
  color: #333;
  font-size: 0.86rem;
  cursor: pointer;
  padding: 0 2px;
  font-family: var(--font-mono);
  transition: color 0.12s;
  line-height: 1;
}
.link-unlink:hover { color: #ef4444; }

.link-select {
  width: 100%;
  background: #0a0a0a;
  border: 1px solid #1a1a1a;
  border-radius: 3px;
  color: #3a3a5a;
  font-size: 0.74rem;
  font-family: var(--font-mono);
  padding: 4px 8px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.link-select:hover { border-color: #2a2a4a; color: #6666aa; }
.link-select:focus { border-color: #3a3a6a; color: #8888cc; }

</style>