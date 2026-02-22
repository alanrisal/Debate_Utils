import { writable, derived } from 'svelte/store'
import { initSearch } from '../lib/search.js'

export const blocks      = writable([])
export const activeTubId = writable(null)
export const isLoaded    = derived(blocks, ($b) => $b.length > 0)

// Re-initialize the Fuse index whenever the block array changes.
blocks.subscribe(($blocks) => {
  if ($blocks.length) initSearch($blocks)
})

// Load (from cache) the block array for a given tub and update the store.
export async function loadTub(tubId) {
  if (!window.flowkit?.loadTubBlocks) return 0
  activeTubId.set(tubId)
  try {
    const loaded = await window.flowkit.loadTubBlocks(tubId)
    blocks.set(loaded ?? [])
    return loaded?.length ?? 0
  } catch (e) {
    console.error('loadTub failed:', e)
    blocks.set([])
    return 0
  }
}

export function clearBlocks() {
  blocks.set([])
  activeTubId.set(null)
}
