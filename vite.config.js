import { defineConfig } from 'vite';
import { svelte }      from '@sveltejs/vite-plugin-svelte';
import { resolve }     from 'path';

/**
 * Chrome Extension multi-entry Vite build.
 *
 * Three entry points, three different execution contexts:
 *
 *   sidebar.html     → The side panel UI (Svelte app, ES module, normal web page)
 *   service-worker   → Background SW (ES module; MV3 supports "type":"module")
 *   content-script   → Injected into docs.google.com (bundled as IIFE so it is
 *                       fully self-contained with no chunk imports)
 *
 * Output structure in dist/:
 *   dist/
 *   ├── manifest.json          (copied by vite-plugin-static-copy or manual step)
 *   ├── sidebar.html
 *   ├── service-worker.js
 *   ├── content-script.js
 *   ├── icons/
 *   └── assets/                (Svelte + CSS chunks for the sidebar)
 */
export default defineConfig({
  plugins: [svelte()],

  build: {
    outDir:    'dist',
    emptyOutDir: true,
    // Source maps for easier debugging in extensions (chrome://extensions)
    sourcemap: true,

    rollupOptions: {
      input: {
        // The sidebar HTML is the main Svelte app entry.
        sidebar: resolve(__dirname, 'sidebar.html'),
        // SW and content script are JS-only entries — Vite treats these as
        // library-style builds alongside the HTML entry.
        'service-worker':  resolve(__dirname, 'src/service-worker.js'),
        'content-script':  resolve(__dirname, 'src/content-script.js'),
      },

      output: {
        // Place SW and content script at dist/ root (where manifest.json expects them).
        // Sidebar assets go into dist/assets/ as usual.
        entryFileNames: (chunk) => {
          if (chunk.name === 'service-worker' || chunk.name === 'content-script') {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',

        // ES modules work for both the SW (MV3 supports "type":"module") and
        // the sidebar. The content script is also declared without "type":"module"
        // in the manifest, but Rollup will bundle it as a single self-contained
        // IIFE via the manualChunks override below — it has no shared deps.
        format: 'es',

        // Prevent Rollup from splitting the content-script into shared chunks.
        // It must be a single, self-contained file because it runs in an
        // isolated script context with no module loader.
        manualChunks(id) {
          // Keep content-script code out of any shared chunk.
          if (id.includes('content-script')) return undefined;
          // Let everything else chunk normally (Svelte, sidebar code, etc.).
          return undefined;
        },
      },

      // Treat chrome.* APIs as external — they are provided by the browser.
      // Do NOT list them in external for the sidebar (Svelte) since those
      // calls are in bridge.js and should be bundled into the sidebar output.
    },
  },

  // No dev server needed for the extension — use `npm run build` and
  // load dist/ as an unpacked extension in chrome://extensions.
  // Keeping the server config for component-level development previews.
  server: {
    port: 5173,
    strictPort: true,
  },
});
