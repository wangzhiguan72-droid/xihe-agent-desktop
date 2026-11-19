const { contextBridge, shell, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('xihe', {
  isDesktop: true,
  openExternal: (u) => shell.openExternal(u),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
