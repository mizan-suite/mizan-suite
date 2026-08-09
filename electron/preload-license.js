// electron/preload-license.js
// Runs in the activation window with contextIsolation enabled. Exposes a tiny,
// purpose-built API to the activation page - nothing else from Node is reachable.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mizanLicense', {
  // Current machine fingerprint (shown so the client can send it to you).
  getMachineId: () => ipcRenderer.invoke('license:get-machine-id'),
  // Current stored status: { status: 'ok'|'unlicensed'|'expired'|'wrong_machine'|... }
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  // Try to activate with a license key. Resolves { ok, reason?, client? }.
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  // Ask the server for a free trial key. Sends { machineId, email } to the
  // vendor's trial endpoint and resolves { ok, days?, expires? } | { ok:false, reason }.
  requestTrial: (email) => ipcRenderer.invoke('license:request-trial', email),
  // Ask the main process to quit the app (the activation screen has no close btn).
  quit: () => ipcRenderer.invoke('license:quit'),
  // Tell the main process activation succeeded, so it can open the app.
  activateFinished: () => ipcRenderer.invoke('license:activate-finished')
});
