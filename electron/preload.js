import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('flowkit', {
  // Renderer → Main: load a sheet URL in the WebContentsView
  openSheet: (url) => ipcRenderer.send('sheet:open', url),

  // Main → Renderer: panel toggled via Ctrl+K global shortcut
  // Returns an unsubscribe function.
  onPanelToggle: (cb) => {
    const handler = (_e, isOpen) => cb(isOpen);
    ipcRenderer.on('panel:toggle', handler);
    return () => ipcRenderer.off('panel:toggle', handler);
  },
});
