import { BrowserWindow, nativeTheme } from "electron";
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
  resizable?: boolean;
  maximizable?: boolean;
}

/** Reuse the host's Electron window setup without exposing security overrides. */
export function createHostWindow(options: HostWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...options.bounds,
    title: options.title,
    frame: false,
    transparent: options.label !== "launcher",
    // The launcher is opaque, so give the compositor a themed backdrop: when a
    // frame is not ready yet the window still appears instead of flashing white.
    backgroundColor:
      options.label === "launcher"
        ? nativeTheme.shouldUseDarkColors
          ? "#1a1917"
          : "#ffffff"
        : undefined,
    show: false,
    resizable: options.resizable ?? true,
    maximizable: options.maximizable ?? true,
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
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown" ||
      input.key !== "F12" ||
      input.isAutoRepeat ||
      input.control ||
      input.alt ||
      input.shift ||
      input.meta
    )
      return;
    event.preventDefault();
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    else win.webContents.openDevTools({ mode: "detach" });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) =>
    console.error("renderer-gone", options.label, details.reason),
  );
  return win;
}
