import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge, Events } from "../shared/desktop-contract.js";

// No ipcRenderer, Node objects, filesystem or arbitrary channel access crosses this boundary.
const labelPrefix = "--spark233-label=";
const bridge: DesktopBridge = {
  label:
    process.argv.find((arg) => arg.startsWith(labelPrefix))?.slice(labelPrefix.length) ?? "main",
  invoke: (command, ...input) => {
    // The isolated preload owns this user-activation check; page scripts cannot
    // forge a native user gesture by passing an IPC argument.
    if (command === "clipboard_read" && !navigator.userActivation.isActive)
      return Promise.resolve({
        ok: false,
        error: { code: "permissionDenied", message: "Clipboard reading requires a user gesture" },
      });
    return ipcRenderer.invoke("spark233:invoke", command, input[0]);
  },
  emit: (name, payload) => ipcRenderer.invoke("spark233:emit", name, payload),
  on: <E extends keyof Events>(name: E, callback: (payload: Events[E]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Events[E]) => callback(payload);
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
};
contextBridge.exposeInMainWorld("spark233Desktop", bridge);
