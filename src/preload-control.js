const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  focusReady: () => ipcRenderer.invoke('focusReady'),
  setLive: on => ipcRenderer.invoke('setLive', on),
  installedApps: () => ipcRenderer.invoke('installedApps'),
  runningApps: () => ipcRenderer.invoke('runningApps'),
  appIcon: p => ipcRenderer.invoke('appIcon', p),
  saveSettings: s => ipcRenderer.invoke('saveSettings', s),
  openPrivateBrowser: () => ipcRenderer.invoke('openPrivateBrowser'),
  openExternal: url => ipcRenderer.invoke('openExternal', url),
  openShortcuts: () => ipcRenderer.invoke('openShortcuts'),
  onState: cb => ipcRenderer.on('state', (e, s) => cb(s))
});
