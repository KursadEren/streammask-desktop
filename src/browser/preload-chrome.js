const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pb', {
  send: msg => ipcRenderer.send('pb', msg),
  onTabs: cb => ipcRenderer.on('tabs', (e, d) => cb(d))
});
