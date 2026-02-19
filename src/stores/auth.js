import { writable } from 'svelte/store';

export const authState = writable({ loggedIn: false, userInfo: null });
