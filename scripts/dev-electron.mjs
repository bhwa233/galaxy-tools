import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const children = new Set();
function run(file, args, env = {}) {
  const child = spawn(file, args, {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  return child;
}
function stop(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
// Resolve the package's public CLI instead of assuming a JavaScript-only compiler.
const compilerPackage = require.resolve("typescript/package.json");
const compilerMetadata = JSON.parse(readFileSync(compilerPackage, "utf8"));
const compilerBin = path.resolve(path.dirname(compilerPackage), compilerMetadata.bin.tsc);
const nativeCompiler = /\.(exe|com)$/i.test(compilerBin);
const compiler = run(nativeCompiler ? compilerBin : process.execPath, [
  ...(nativeCompiler ? [] : [compilerBin]),
  "-p",
  "electron/tsconfig.json",
]);
compiler.on("exit", async (code) => {
  children.delete(compiler);
  if (code) return stop(code);
  await import("./copy-electron-assets.mjs");
  try {
    // Installed notes carry their renderer; development uses the same seven
    // bundled package preparation as the production install path.
    execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      stdio: "inherit",
      windowsHide: true,
    });
    await import("./build-official-plugins.mjs");
  } catch (error) {
    console.error("Bundled plugin preparation failed", error);
    return stop(1);
  }
  const vite = run(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]);
  vite.on("exit", () => stop(1));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:1420");
      if (response.ok) break;
    } catch {}
    if (attempt === 99) return stop(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const electron = run(require("electron"), [".", ...process.argv.slice(2)], {
    ELECTRON_RENDERER_URL: "http://127.0.0.1:1420",
  });
  electron.on("exit", (exitCode) => stop(exitCode ?? 0));
});
