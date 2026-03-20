const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioBridge', {
    getAUPlugins: () => ipcRenderer.invoke('get-au-plugins'),
    auCreateInstance: (type, subtype, mfg) => ipcRenderer.invoke('au-create-instance', type, subtype, mfg),
    auOpenEditor: (id, title) => ipcRenderer.invoke('au-open-editor', id, title),
    auCloseEditor: (id) => ipcRenderer.invoke('au-close-editor', id),
    auDestroyInstance: (id) => ipcRenderer.invoke('au-destroy-instance', id),
    isElectron: true
});
