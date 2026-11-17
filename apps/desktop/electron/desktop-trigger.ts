import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { screen } from "electron";

/** Reuse FullscreenWatcher's in-box compiler and child lifetime. Electron has no
 * Explorer child-window API; this narrow helper never creates a topmost hotspot. */
export function startDesktopTrigger(options: {
  here: string;
  configDir: string;
  enabled(): boolean;
  label: string;
  open(displayId: string): Promise<void>;
}): () => void {
  if (process.platform !== "win32") return () => {};
  let disposed = false;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let opening = false;
  const start = async () => {
    const source = fs.readFileSync(path.join(options.here, "assets/DesktopTrigger.cs"));
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const root = path.join(options.configDir, "native");
    fs.mkdirSync(root, { recursive: true });
    const exe = path.join(root, `desktop-trigger-${hash}.exe`);
    if (!fs.existsSync(exe)) {
      const file = path.join(root, `desktop-trigger-${hash}.cs`);
      fs.writeFileSync(file, source);
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
            "/r:System.Windows.Forms.dll",
            "/r:System.Drawing.dll",
            `/out:${exe}`,
            file,
          ],
          { windowsHide: true, timeout: 30000 },
          (error, stdout, stderr) =>
            error
              ? reject(
                  new Error(`Desktop trigger compilation failed: ${stdout} ${stderr}`, {
                    cause: error,
                  }),
                )
              : resolve(),
        ),
      );
    }
    if (disposed) return;
    child = spawn(exe, [String(process.pid)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SPARK233_TRIGGER_LABEL: options.label },
    });
    child.stdin!.on("error", () => {});
    const update = () => {
      if (child?.stdin?.writable)
        child.stdin.write(options.enabled() && !opening ? "enabled\n" : "disabled\n");
    };
    update();
    timer = setInterval(update, 500);
    timer.unref();
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 8192) {
        child?.kill();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        const match = /^click (-?\d+) (-?\d+)$/.exec(line);
        if (!match || !options.enabled() || opening) continue;
        const x = Number(match[1]);
        const y = Number(match[2]);
        if (![x, y].every((value) => Number.isInteger(value) && Math.abs(value) < 2 ** 31))
          continue;
        const point = screen.screenToDipPoint({ x, y });
        const display = screen.getDisplayNearestPoint(point);
        const bounds = display.bounds;
        // A click queued before a monitor disconnect must not open on whichever
        // display happens to become nearest after the topology changed.
        if (
          point.x < bounds.x ||
          point.x >= bounds.x + bounds.width ||
          point.y < bounds.y ||
          point.y >= bounds.y + bounds.height
        )
          continue;
        opening = true;
        void options
          .open(String(display.id))
          .catch((error) => console.error("desktop-trigger", error))
          .finally(() => {
            opening = false;
          });
      }
    });
    child.stderr!.on("data", (data) => console.error("desktop-trigger", String(data)));
    child.on("error", (error) => console.error("desktop-trigger", error));
    child.once("close", () => {
      clearInterval(timer);
    });
  };
  void start().catch((error) => console.error("desktop-trigger", error));
  return () => {
    disposed = true;
    clearInterval(timer);
    child?.stdin?.end();
    child?.kill();
  };
}
