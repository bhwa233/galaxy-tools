import { contextBridge, ipcRenderer, webUtils } from "electron";

// No ipcRenderer, Node objects, filesystem or arbitrary channel access crosses this boundary.
contextBridge.exposeInMainWorld("floralDesktop", {
  label: process.argv.find((arg) => arg.startsWith("--floral-label="))?.slice(15) ?? "main",
  invoke: (command: string, args?: unknown) => ipcRenderer.invoke("floral:invoke", command, args),
  emit: (name: string, payload?: unknown) => ipcRenderer.invoke("floral:emit", name, payload),
  on: (name: string, callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(`floral:event:${name}`, handler);
    return () => ipcRenderer.removeListener(`floral:event:${name}`, handler);
  },
  droppedPaths: (files: File[]) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("floral:drop", paths);
  },
});
