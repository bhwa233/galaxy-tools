import { contextBridge, ipcRenderer, webUtils } from "electron";

// No ipcRenderer, Node objects, filesystem or arbitrary channel access crosses this boundary.
const labelPrefix = "--spark233-label=";
contextBridge.exposeInMainWorld("spark233Desktop", {
  label:
    process.argv.find((arg) => arg.startsWith(labelPrefix))?.slice(labelPrefix.length) ?? "main",
  invoke: (command: string, args?: unknown) => ipcRenderer.invoke("spark233:invoke", command, args),
  emit: (name: string, payload?: unknown) => ipcRenderer.invoke("spark233:emit", name, payload),
  on: (name: string, callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(`spark233:event:${name}`, handler);
    return () => ipcRenderer.removeListener(`spark233:event:${name}`, handler);
  },
  droppedPaths: (files: File[]) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("spark233:drop", paths);
  },
  droppedApplicationEntries: (files: File[]) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("spark233:application-drop", paths);
  },
});
