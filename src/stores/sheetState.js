import { writable } from 'svelte/store';

// URL currently loaded in the WebContentsView.
export const currentSheetUrl = writable('');
