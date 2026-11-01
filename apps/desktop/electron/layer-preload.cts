import { contextBridge, ipcRenderer } from "electron";
import type { LayerClient, LayerClientRequest, LayerEvent } from "../shared/layer-contract.js";

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(name))?.slice(name.length);
const surfaceId = argument("--spark233-surface=") ?? "";
const surfaceGeneration = Number(argument("--spark233-surface-generation="));
let seq = 0;
if (process.isMainFrame && surfaceId && Number.isSafeInteger(surfaceGeneration)) {
  const client: LayerClient = {
    request: (request: LayerClientRequest) =>
      ipcRenderer.invoke("spark233:layer", {
        ...request,
        protocol: 1,
        surfaceId,
        surfaceGeneration,
        seq: ++seq,
        // Only this trusted preload can attest a native user activation.
        userGesture:
          (request.type === "widget-invoke" || request.type === "widget-confirm-open") &&
          navigator.userActivation.isActive,
      }),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: LayerEvent) => listener(value);
      ipcRenderer.on("spark233:layer-event", handler);
      return () => ipcRenderer.removeListener("spark233:layer-event", handler);
    },
  };
  contextBridge.exposeInMainWorld("spark233Layer", client);
}
