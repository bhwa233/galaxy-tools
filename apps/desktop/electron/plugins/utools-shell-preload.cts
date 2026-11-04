const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
contextBridge.exposeInMainWorld("utoolsShell", {
  state: () => ipcRenderer.invoke("utools:shell", "state"),
  action: (name: string, value?: unknown) => ipcRenderer.invoke("utools:shell", name, value),
  subscribe: (listener: (state: unknown) => void) => {
    const receive = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("utools:shell-state", receive);
    return () => ipcRenderer.removeListener("utools:shell-state", receive);
  },
});
