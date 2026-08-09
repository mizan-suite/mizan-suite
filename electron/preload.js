// electron/preload.js
// Runs in the app window (contextIsolation on). Exposes a tiny, safe API for
// printing: listing the installed printers and silently printing the current
// page to a chosen printer. Everything else stays sandboxed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('akPrint', {
  // -> PrinterInfo[] (name, displayName, status, isDefault, ...)
  getPrinters: () => ipcRenderer.invoke('print:get-printers'),
  // options: { deviceName } - prints the current page with no dialog.
  print: (options) => ipcRenderer.invoke('print:page', options),
  // options: { deviceName, data: number[] } - sends raw bytes straight to the
  // printer (ESC/POS). Bypasses the GDI driver that thermal printers often
  // cannot rasterize. -> { ok, error? }
  printRaw: (options) => ipcRenderer.invoke('print:raw', options)
});
