import { mkdirSync, copyFileSync } from "node:fs";
const desktopRoot = new URL("../", import.meta.url);
mkdirSync(new URL("dist-electron/electron/assets", desktopRoot), { recursive: true });
for (const name of ["icon.ico", "32x32.png", "FullscreenWatcher.cs", "SelectionReader.cs"])
  copyFileSync(
    new URL(`electron/assets/${name}`, desktopRoot),
    new URL(`dist-electron/electron/assets/${name}`, desktopRoot),
  );
