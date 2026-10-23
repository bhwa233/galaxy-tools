import path from "node:path";

/**
 * AMD Radeon 780M / driver 32.0.13032.11 aborts during D3D11 initialization when
 * a packaged Electron process inherits a WSL UNC working directory. Changing
 * only the working directory to a local path removes the failure. Keep GPU
 * acceleration and every sandbox enabled; application storage uses absolute paths.
 */
export function initializeWindowsRuntime(): void {
  if (process.platform === "win32") process.chdir(path.dirname(process.execPath));
}

import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { screen, type BrowserWindow } from "electron";
import type { Rect } from "../src/features/capsules/types.js";

/** .NET Framework's in-box compiler builds a tiny Win32 observer once per source hash.
 * Reuse Electron for windows/DIP conversion; only external foreground discovery needs Win32.
 * A persistent PowerShell process or an FFI dependency would cost more for this narrow boundary.
 */
export function watchFullscreen(
  here: string,
  configDir: string,
  onChange: (rects: Rect[]) => void,
  getWindows: () => BrowserWindow[],
): () => void {
  if (process.platform !== "win32") return () => {};
  let disposed = false,
    child: ChildProcess | undefined;
  let handlesTimer: ReturnType<typeof setInterval> | undefined;
  const start = async () => {
    const source = fs.readFileSync(path.join(here, "assets/FullscreenWatcher.cs"));
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const dir = path.join(configDir, "native");
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, `fullscreen-${hash}.exe`);
    if (!fs.existsSync(exe)) {
      const file = path.join(dir, `fullscreen-${hash}.cs`);
      fs.writeFileSync(file, source);
      const compiler = path.join(
        process.env.WINDIR || "C:\\Windows",
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe",
      );
      await new Promise<void>((resolve, reject) =>
        execFile(
          compiler,
          ["/nologo", "/optimize+", "/target:exe", `/out:${exe}`, file],
          { windowsHide: true, timeout: 30000 },
          (error, stdout, stderr) =>
            error
              ? reject(new Error(`Fullscreen watcher compile failed: ${stdout} ${stderr}`))
              : resolve(),
        ),
      );
    }
    if (disposed) return;
    child = spawn(exe, [String(process.pid)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin!.on("error", () => {});
    handlesTimer = setInterval(() => {
      if (!child || child.killed) return;
      const handles = getWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => {
          const b = w.getNativeWindowHandle();
          return b.length === 8 ? b.readBigUInt64LE().toString() : String(b.readUInt32LE());
        });
      child.stdin!.write(handles.join(" ") + "\n");
    }, 650);
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line === "none") onChange([]);
        else {
          const values = line.split(" ");
          if (
            values[0] === "rect" &&
            values.length === 5 &&
            values.slice(1).every((n) => Number.isFinite(Number(n)))
          ) {
            const [x, y, width, height] = values.slice(1).map(Number);
            onChange([screen.screenToDipRect(null, { x, y, width, height })]);
          }
        }
      }
    });
    child.on("error", (error) => console.error("fullscreen-watcher", error));
    child.stderr!.on("data", (data) => console.error("fullscreen-watcher", String(data)));
  };
  void start().catch((error) => console.error("fullscreen-watcher", error));
  return () => {
    disposed = true;
    clearInterval(handlesTimer);
    child?.kill();
  };
}
