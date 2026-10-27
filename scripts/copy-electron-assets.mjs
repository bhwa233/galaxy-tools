import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist-electron/electron/assets", { recursive: true });
for (const name of ["icon.ico", "32x32.png", "FullscreenWatcher.cs", "ContextPanelHelper.cs"])
  copyFileSync(`electron/assets/${name}`, `dist-electron/electron/assets/${name}`);
