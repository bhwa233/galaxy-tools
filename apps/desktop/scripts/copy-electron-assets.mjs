import { mkdirSync, copyFileSync, cpSync } from "node:fs";
const desktopRoot = new URL("../", import.meta.url);
mkdirSync(new URL("dist-electron/electron/assets", desktopRoot), { recursive: true });
for (const name of [
  "icon.ico",
  "32x32.png",
  "icon.svg",
  "icon.png",
  "tray-light.png",
  "tray-dark.png",
  "FullscreenWatcher.cs",
  "SelectionReader.cs",
  "host-windows.json",
])
  copyFileSync(
    new URL(`electron/assets/${name}`, desktopRoot),
    new URL(`dist-electron/electron/assets/${name}`, desktopRoot),
  );
cpSync(
  new URL("electron/assets/settings", desktopRoot),
  new URL("dist-electron/electron/assets/settings", desktopRoot),
  { recursive: true },
);
cpSync(
  new URL("electron/assets/theme-icons", desktopRoot),
  new URL("dist-electron/electron/assets/theme-icons", desktopRoot),
  { recursive: true },
);
