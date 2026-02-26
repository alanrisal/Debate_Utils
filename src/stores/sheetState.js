import { writable } from 'svelte/store';

// URL currently loaded in the WebContentsView.
export const currentSheetUrl = writable('');

// True when the open document is a native Google Sheet (supports Sheets API).
// False for Excel/XLSX files viewed in Drive — tab creation is not supported.
export const currentSheetIsNative = writable(true);
