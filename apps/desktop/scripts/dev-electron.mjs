import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, lstatSync, realpathSync, unlinkSync, watch } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
// Some harnesses and shells export ELECTRON_RUN_AS_NODE=1 to run Electron as
// plain Node. The development launcher must always start the real application.
delete process.env.ELECTRON_RUN_AS_NODE;
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
    if (stopping) return;
    if (activeElectron.connected) {
      stopping = true;
      activeElectron.send("spark233-dev-reload", (error) => {
        if (!error) return;
        stopping = false;
        console.error("Cannot request a safe application shutdown; keep the process open.", error);
      });
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
    env: {
      ...process.env,
      ...devEnvironment,
      // A development machine without the MSVC toolchain still starts; plugins
      // whose prebuilt payload is absent stay out instead of failing the run.
      SPARK233_DEV_SKIP_MISSING_NATIVE: "1",
      SPARK233_DEV_PLUGIN_BUILD: String(Date.now()),
    },
  });
}
function buildCapturePlugins() {
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
      "-WithOcr",
    ],
    { cwd: projectRoot, stdio: "inherit", windowsHide: true },
  );
  execFileSync(
    path.join(toolchains, powershell, "pwsh.exe"),
    [
      "-NoProfile",
      "-File",
      path.join(projectRoot, "scripts/native-capture/prepare-vc-runtime.ps1"),
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
}
const nativePayloadsScript = path.join(projectRoot, "scripts/native-payloads.mjs");
function nativePayloadsReady() {
  try {
    execFileSync(process.execPath, [nativePayloadsScript, "has"], {
      stdio: "ignore",
      windowsHide: true,
      cwd: projectRoot,
    });
    return true;
  } catch {
    return false;
  }
}
function hasToolchainPowerShell() {
  const toolchains = path.join(process.env.LOCALAPPDATA, "spark233", "toolchains");
  try {
    return readdirSync(toolchains).some((name) => /^powershell-7\./.test(name));
  } catch {
    return false;
  }
}
/**
 * Prefer prebuilt payloads so a development machine needs no native toolchain.
 * CI packs them with scripts/native-payloads.mjs; machines that have the MSVC
 * toolchain keep building from source, which is required when native sources
 * change.
 */
function prepareNative() {
  if (nativePayloadsReady()) {
    console.log("Using prebuilt native payloads.");
    return;
  }
  if (hasToolchainPowerShell()) {
    buildCapturePlugins();
    return;
  }
  const source = process.env.SPARK233_NATIVE_PAYLOAD_URL;
  if (source) {
    console.log(`Downloading prebuilt native payloads from ${source}`);
    execFileSync(process.execPath, [nativePayloadsScript, "fetch", "--from", source], {
      stdio: "inherit",
      windowsHide: true,
      cwd: projectRoot,
    });
    return;
  }
  console.warn(
    "Native toolchain and prebuilt payloads are unavailable; screenshot, OCR, clipboard, applications and search plugins are skipped. Run `pnpm native:fetch --from <release-url>` to enable them.",
  );
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
    prepareNative();
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
  function cleanupDevPluginArchives() {
    if (building) return;
    const root = devEnvironment.SPARK233_DEV_PLUGIN_OUTPUT;
    const expected = path.join(devRoot, "plugins");
    if (path.resolve(root) !== expected || lstatSync(root).isSymbolicLink())
      throw new Error("Development archive cleanup escaped dev/plugins");
    const canonicalRoot = realpathSync.native(root);
    if (path.dirname(canonicalRoot) !== realpathSync.native(devRoot))
      throw new Error("Development archive cleanup follows a redirected directory");
    const indexFile = path.join(root, "index.json");
    if (lstatSync(indexFile).isSymbolicLink())
      throw new Error("Development archive index is a symlink");
    const indexText = readFileSync(indexFile, "utf8");
    const index = JSON.parse(indexText);
    if (
      !Array.isArray(index.plugins) ||
      index.plugins.some(
        (entry) => typeof entry.file !== "string" || path.basename(entry.file) !== entry.file,
      )
    )
      throw new Error("Development archive index is invalid");
    const keep = new Set(index.plugins.map((entry) => entry.file));
    const names = readdirSync(root);
    const publishing = () =>
      building || readdirSync(root).some((name) => /^\.dev-build-\d+-\d+\.active$/.test(name));
    if (publishing()) return;
    for (const name of names) {
      if (!/^[a-z0-9-]+-\d+\.\d+\.\d{13,15}\.tgz$/.test(name) || keep.has(name)) continue;
      // Fail closed if another publisher starts or replaces the index while
      // this old Electron exit is being handled. Cleanup can wait a restart.
      if (publishing() || readFileSync(indexFile, "utf8") !== indexText) return;
      const file = path.join(root, name);
      if (
        lstatSync(file).isSymbolicLink() ||
        path.dirname(realpathSync.native(file)) !== canonicalRoot
      )
        throw new Error("Development archive cleanup follows a redirected file");
      if (lstatSync(file).isFile()) unlinkSync(file);
    }
  }
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
        try {
          cleanupDevPluginArchives();
        } catch (error) {
          console.error("Development archive cleanup skipped", error);
        }
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
    if (building || restarting || stopping) return;
    dirty = false;
    building = true;
    try {
      console.log("Rebuilding local plugins for development...");
      if (captureDirty) {
        prepareNative();
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
      execFileSync(process.execPath, [path.join(desktopRoot, "scripts/copy-electron-assets.mjs")], {
        cwd: desktopRoot,
        stdio: "inherit",
        windowsHide: true,
      });
      buildPlugins();
      if (!electron.connected)
        throw new Error("The application's development IPC channel is closed");
      restarting = true;
      electron.send("spark233-dev-reload", (error) => {
        if (!error) return;
        restarting = false;
        console.error("Development reload failed; the current application remains open.", error);
      });
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
    "scripts/native-capture",
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
        /(?:^|\/)(notes|clipboard|traffic|quicklinks)\/backend\.mjs$/.test(file) ||
        /\.test\.[cm]?[jt]sx?$/.test(file)
      )
        return;
      if (relative === "native/capture" || relative === "scripts/native-capture")
        captureDirty = true;
      schedule();
    });
    watcher.on("error", (error) => console.error("Development watcher failed", error));
  }
  startElectron();
});
