import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // './' base makes built assets load correctly from Electron's file:// protocol.
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
})
