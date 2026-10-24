import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const children = new Set();
function run(file, args, env = {}) {
  const child = spawn(file, args, { stdio: "inherit", env: { ...process.env, ...env } });
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
const compiler = run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "-p",
  "electron/tsconfig.json",
]);
compiler.on("exit", async (code) => {
  children.delete(compiler);
  if (code) return stop(code);
  await import("./copy-electron-assets.mjs");
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
  const electron = run(require("electron"), ["."], {
    ELECTRON_RENDERER_URL: "http://127.0.0.1:1420",
  });
  electron.on("exit", (exitCode) => stop(exitCode ?? 0));
});
