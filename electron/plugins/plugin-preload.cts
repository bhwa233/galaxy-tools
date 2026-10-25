import { contextBridge, ipcRenderer } from "electron";
import type {
  JsonValue,
  PluginBrowserBridge,
  PluginWebEvent,
  PluginWebOperation,
} from "../../packages/sdk/src/index.js";

const instanceId = process.argv
  .find((argument) => argument.startsWith("--spark233-instance="))
  ?.slice("--spark233-instance=".length);
const operations = new Set<PluginWebOperation>([
  "context.get",
  "storage.get",
  "storage.set",
  "storage.remove",
  "command.register",
  "window.close",
  "capability.invoke",
  "lifecycle.result",
  "query.result",
]);
const bridge: PluginBrowserBridge = {
  request: (operation, payload?: JsonValue) => {
    if (!instanceId || !operations.has(operation))
      return Promise.reject(new Error("Unsupported plugin operation"));
    return ipcRenderer.invoke("spark233:plugin-web:invoke", { instanceId, operation, payload });
  },
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: PluginWebEvent) => listener(value);
    ipcRenderer.on("spark233:plugin-web:event", handler);
    return () => {
      ipcRenderer.removeListener("spark233:plugin-web:event", handler);
    };
  },
};
// A sandboxed preload can require Electron itself; type imports above erase.
// Never expose ipcRenderer, Electron event objects, Node globals or arbitrary channels.
contextBridge.exposeInMainWorld("spark233", Object.freeze(bridge));
