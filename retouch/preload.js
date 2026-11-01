const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('gcr', {
  pickPhotos: () => ipcRenderer.invoke('pick-photos'),
  expandPaths: (paths) => ipcRenderer.invoke('expand-paths', paths),
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
  pickLogo: () => ipcRenderer.invoke('pick-logo'),
  pickOutput: (suggested) => ipcRenderer.invoke('pick-output', suggested),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (dir, name, bytes) => ipcRenderer.invoke('write-file', dir, name, bytes),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  version: () => ipcRenderer.invoke('app-version'),
});
