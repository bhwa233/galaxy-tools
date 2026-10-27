import { BrowserWindow } from "electron";
import type { NativeImage, Rectangle } from "electron";

export interface HostWindowOptions {
  bounds: Rectangle;
  title: string;
  preload: string;
  icon: string | NativeImage;
  minWidth: number;
  minHeight: number;
  skipTaskbar: boolean;
  alwaysOnTop: boolean;
  hasShadow: boolean;
  label: string;
}

/** Reuse the host's Electron window setup without exposing security overrides. */
export function createHostWindow(options: HostWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...options.bounds,
    title: options.title,
    frame: false,
    transparent: true,
    show: false,
    resizable: true,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    skipTaskbar: options.skipTaskbar,
    alwaysOnTop: options.alwaysOnTop,
    hasShadow: options.hasShadow,
    icon: options.icon,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: true,
      additionalArguments: [`--spark233-label=${options.label}`],
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) =>
    console.error("renderer-gone", options.label, details.reason),
  );
  return win;
}
