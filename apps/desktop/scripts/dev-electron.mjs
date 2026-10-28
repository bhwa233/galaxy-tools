import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, watch } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = path.resolve(desktopRoot, "../..");
const devRoot = path.join(projectRoot, "local-build", "spark233", "dev");
const devEnvironment = {
  SPARK233_CONFIG_DIR: path.join(devRoot, "config"),
  SPARK233_DATA_DIR: path.join(devRoot, "data"),
  SPARK233_DEV_PLUGIN_OUTPUT: path.join(devRoot, "plugins"),
  SPARK233_DEV_PLUGINS: "1",
};
const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
const children = new Set();
let activeElectron;
let stopping = false;
function run(file, args, env = {}, ipc = false) {
  const child = spawn(file, args, {
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    windowsHide: true,
    cwd: desktopRoot,
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
  if (activeElectron) {
    if (activeElectron.connected) {
      stopping = true;
      activeElectron.send("spark233-dev-reload");
    } else console.error("Cannot request a safe application shutdown; keep the process open.");
    return;
  }
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
const compilerCommand = nativeCompiler ? compilerBin : process.execPath;
const compilerPrefix = nativeCompiler ? [] : [compilerBin];
function buildPlugins() {
  execFileSync(process.execPath, [path.join(projectRoot, "scripts/build-official-plugins.mjs")], {
    stdio: "inherit",
    windowsHide: true,
    cwd: projectRoot,
    env: { ...process.env, ...devEnvironment, SPARK233_DEV_PLUGIN_BUILD: String(Date.now()) },
  });
}
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
    execFileSync(process.execPath, [viteBin, "build"], {
      stdio: "inherit",
      windowsHide: true,
      cwd: desktopRoot,
    });
    buildPlugins();
  } catch (error) {
    console.error("Bundled plugin preparation failed", error);
    return stop(1);
  }
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("No development port"));
      probe.close(() => resolve(address.port));
    });
  });
  const devUrl = `http://127.0.0.1:${port}`;
  const vite = run(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)]);
  vite.on("exit", () => stop(1));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(devUrl);
      if (response.ok) break;
    } catch {}
    if (attempt === 99) return stop(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  let electron;
  let restarting = false;
  let building = false;
  let dirty = false;
  let captureDirty = false;
  let timer;
  function startElectron() {
    electron = run(
      require("electron"),
      [".", ...process.argv.slice(2)],
      {
        ...devEnvironment,
        ELECTRON_RENDERER_URL: devUrl,
        SPARK233_DEV_PORT: String(port),
      },
      true,
    );
    activeElectron = electron;
    electron.on("message", (message) => {
      if (message === "spark233-dev-reload-refused") {
        restarting = false;
        stopping = false;
        console.error("Development reload cancelled: the application could not safely close.");
      }
    });
    electron.on("exit", (exitCode) => {
      children.delete(electron);
      activeElectron = undefined;
      if (restarting && !stopping && exitCode === 0) {
        restarting = false;
        startElectron();
        if (dirty) schedule();
      } else stop(exitCode ?? 0);
    });
  }
  function schedule() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 500);
  }
  function rebuild() {
    if (building || restarting) return;
    dirty = false;
    building = true;
    try {
      console.log("Rebuilding local plugins for development...");
      if (captureDirty) {
        const toolchains = path.join(process.env.LOCALAPPDATA, "spark233", "toolchains");
        const powershell = readdirSync(toolchains)
          .filter((name) => /^powershell-7\./.test(name))
          .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
        if (!powershell) throw new Error("PowerShell 7 is required for native capture builds");
        const buildRoot = path.join(projectRoot, "local-build/spark233/native-capture-p4");
        execFileSync(
          path.join(toolchains, powershell, "pwsh.exe"),
          [
            "-NoProfile",
            "-File",
            path.join(projectRoot, "scripts/native-capture/build.ps1"),
            "-OutputRoot",
            buildRoot,
            "-OpenCVDirectory",
            path.join(
              projectRoot,
              "local-build/spark233/native-capture/deps/opencv/x64/vc18/staticlib",
            ),
            "-OnnxRuntimeRoot",
            path.join(
              projectRoot,
              "local-build/spark233/native-capture/deps/onnxruntime-win-x64-1.23.2",
            ),
          ],
          { cwd: projectRoot, stdio: "inherit", windowsHide: true },
        );
        for (const plugin of ["screenshot", "ocr"])
          execFileSync(
            process.execPath,
            [
              path.join(projectRoot, `packages/official/${plugin}/build.mjs`),
              "--native-build-dir",
              path.join(buildRoot, "build"),
            ],
            {
              cwd: projectRoot,
              stdio: "inherit",
              windowsHide: true,
            },
          );
        captureDirty = false;
      }
      execFileSync(compilerCommand, [...compilerPrefix, "-p", "packages/sdk/tsconfig.json"], {
        cwd: projectRoot,
        stdio: "inherit",
        windowsHide: true,
      });
      execFileSync(compilerCommand, [...compilerPrefix, "-p", "electron/tsconfig.json"], {
        cwd: desktopRoot,
        stdio: "inherit",
        windowsHide: true,
      });
      buildPlugins();
      restarting = true;
      electron.send("spark233-dev-reload");
    } catch (error) {
      console.error("Development rebuild failed; the current application remains open.", error);
    } finally {
      building = false;
      if (dirty && !restarting) schedule();
    }
  }
  for (const relative of [
    "packages/official",
    "packages/sdk/src",
    "apps/desktop/electron",
    "native/applications",
    "native/capture",
    "scripts/native-clipboard",
    "scripts/native-search",
    "scripts/native-applications",
  ]) {
    const directory = path.join(projectRoot, relative);
    const watcher = watch(directory, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const file = String(filename).replaceAll("\\", "/");
      if (
        /(^|\/)(node_modules|native|legal|data|licenses|dist)(\/|$)/.test(file) ||
        /(?:^|\/)backend-resources\.json$/.test(file) ||
        /(?:^|\/)(notes|clipboard)\/backend\.mjs$/.test(file) ||
        /\.test\.[cm]?[jt]sx?$/.test(file)
      )
        return;
      if (relative === "native/capture") captureDirty = true;
      schedule();
    });
    watcher.on("error", (error) => console.error("Development watcher failed", error));
  }
  startElectron();
});
