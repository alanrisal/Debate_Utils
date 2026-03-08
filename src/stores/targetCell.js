import { writable } from 'svelte/store';

/**
 * Tracks the cell currently targeted for block injection.
 *
 * Set by:
 *   - content-script mouseup → user clicks a cell in the sheet (sets initial position)
 *   - BlockPanel arrow keys  → user navigates from the sidebar (moves position)
 *
 * Read by:
 *   - BlockPanel  (to display current target and drive movement)
 *   - service-worker (via cell:setTarget IPC to apply the API highlight)
 */
export const targetCell = writable({
  cell:          null,  // e.g. "B3" — null until user clicks a starting cell
  gid:           0,     // numeric sheetId (from #gid= in URL)
  spreadsheetId: null,
});
