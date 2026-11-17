import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { app, type BrowserWindow } from "electron";

const prepared = new WeakMap<BrowserWindow, Promise<void>>();
let executable: Promise<string> | undefined;

// Electron's thickFrame:false also removes native edge resizing. Reuse the
// existing FullscreenWatcher in-box compiler pattern for the narrower DWM flag;
// no FFI dependency, global Windows setting or renderer privilege is needed.
async function compile(): Promise<string> {
  const source = fs.readFileSync(new URL("./assets/WindowTransitions.cs", import.meta.url));
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const root = path.join(app.getPath("userData"), "native");
  fs.mkdirSync(root, { recursive: true });
  const exe = path.join(root, `window-transitions-${hash}.exe`);
  if (!fs.existsSync(exe)) {
    const compiler = path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    );
    await new Promise<void>((resolve, reject) =>
      execFile(
        compiler,
        [
          "/nologo",
          "/optimize+",
          "/target:exe",
          `/out:${exe}`,
          fileURLToPath(new URL("./assets/WindowTransitions.cs", import.meta.url)),
        ],
        { windowsHide: true, timeout: 10000 },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  return exe;
}

/** Prepare once, before a card's first native show/hide. Fail open on unsupported DWM. */
export function prepareInstantWindow(window: BrowserWindow): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  let ready = prepared.get(window);
  if (!ready) {
    ready = (async () => {
      const exe = await (executable ??= compile());
      if (window.isDestroyed()) return;
      const handle = window.getNativeWindowHandle();
      const id = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
      await new Promise<void>((resolve, reject) =>
        execFile(
          exe,
          [String(id), String(process.pid)],
          { windowsHide: true, timeout: 1500 },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    })().catch((error) => console.error("window-transitions", error));
    prepared.set(window, ready);
  }
  return ready;
}
