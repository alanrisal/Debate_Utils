import { writable } from 'svelte/store';

export const launcherOpen      = writable(false);
export const launcherNewFormat = writable('Policy'); // pre-seeds new flow form from template click
export const launcherMode      = writable('open');   // 'open' | 'new-flow'
export const sheetFormat       = writable('Policy'); // active format for Aff/Neg tab insertion
export const panelOpen         = writable(false);    // kept for compat, no longer drives layout
export const sidebarView       = writable('home');   // 'kit' | 'home'
