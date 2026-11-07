// Trusted preload of the host-owned shell window around a Web plugin page. The
// plugin page itself runs in a separate WebContentsView with plugin-preload and
// can neither see nor call this bridge.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("pluginShell", {
  state: () => ipcRenderer.invoke("spark233:plugin-shell", "state"),
  action: (name: string) => ipcRenderer.invoke("spark233:plugin-shell", name),
  subscribe: (listener: (state: unknown) => void) => {
    const receive = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("spark233:plugin-shell:state", receive);
    return () => ipcRenderer.removeListener("spark233:plugin-shell:state", receive);
  },
});
