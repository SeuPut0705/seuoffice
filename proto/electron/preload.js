// window.__shell for proto/common/host/host.js over Electron IPC
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__shell', {
  config: () => ipcRenderer.invoke('bench_config'),
  openFile: (path) => ipcRenderer.invoke('open_file', path),
  saveFile: (path, bytes) => ipcRenderer.invoke('save_file', path, bytes),
  echo: (bytes) => ipcRenderer.invoke('echo', bytes),
  report: (obj) => ipcRenderer.invoke('report', obj),
  printPdf: (out, width, height) => ipcRenderer.invoke('print_pdf', out, width, height),
})
