import { writable } from 'svelte/store';

export const toast = writable(null); // { message, type }

let _timer = null;

export async function showToast(message, type = 'error', duration = 4000) {
  if (_timer) clearTimeout(_timer);

  // Wait for main to push the sheet view down before the strip renders,
  // otherwise the sheet covers the toast for the first few frames.
  await window.flowkit?.toggleToast(true);

  toast.set({ message, type });

  _timer = setTimeout(async () => {
    toast.set(null);
    // Small delay lets the fly-out animation finish before the sheet snaps back.
    await new Promise(r => setTimeout(r, 180));
    window.flowkit?.toggleToast(false);
  }, duration);
}
