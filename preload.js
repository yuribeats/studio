const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioBridge', {
    getAUPlugins: () => ipcRenderer.invoke('get-au-plugins'),
    isElectron: true
});
