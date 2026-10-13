const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  invoke: (c, a) => ipcRenderer.invoke(c, a),
  on: (c, f) => ipcRenderer.on(c, (e, d) => f(d))
});
