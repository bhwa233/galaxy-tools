import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { atomicWrite, confined } from "./persistence.js";

const selection = z.strictObject({
  id: z.uuid(),
  text: z
    .string()
    .max(65536)
    .refine((text) => Buffer.byteLength(text, "utf8") <= 65536),
});
const foreground = z.strictObject({ id: z.uuid(), window: z.number().int().nonnegative() });
interface SelectionWorker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exited: Promise<void>;
  active: boolean;
  finish?: (text: string) => void;
  foreground?: (window: number) => void;
}

/** Reuses windows-runtime's in-box compiler and the host's cache primitives.
 * Electron has no external-app selection API. This helper only reads UIA;
 * it installs no hooks and never accesses the clipboard or sends input. */
export class NativeSelectionReader {
  private executable?: Promise<string>;
  private starting?: Promise<SelectionWorker>;
  private worker?: SelectionWorker;
  private readonly workers = new Set<SelectionWorker>();
  private readonly abort = new AbortController();

  constructor(private readonly options: { assetDirectory: string; cacheDirectory: string }) {}

  async prepare(): Promise<void> {
    if (process.platform === "win32") await this.getWorker();
  }

  async read(signal: AbortSignal, target = 0): Promise<string> {
    if (process.platform !== "win32" || signal.aborted || this.abort.signal.aborted) return "";
    try {
      return await this.capture(AbortSignal.any([signal, this.abort.signal]), target);
    } catch {
      return "";
    }
  }

  /** Samples the foreground window before the launcher takes focus. Returns 0
   * unless a warm helper answers almost immediately: a cold helper must not
   * delay the panel, and the read then degrades to an empty input. */
  async target(signal: AbortSignal): Promise<number> {
    if (process.platform !== "win32" || signal.aborted || this.abort.signal.aborted) return 0;
    const worker = this.worker;
    if (!worker?.active || worker.finish || worker.foreground) return 0;
    const id = randomUUID();
    return new Promise<number>((resolve) => {
      const settle = (window: number) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        worker.foreground = undefined;
        this.requests.delete(worker);
        resolve(window);
      };
      // A slow sample only costs accuracy: never kill the warm helper for it,
      // otherwise every missed deadline turns the next read into a cold start.
      const timeout = () => settle(0);
      const fail = () => {
        settle(0);
        this.retire(worker);
      };
      const timer = setTimeout(timeout, 120);
      worker.foreground = (window) => settle(window);
      this.requests.set(worker, { id, kind: "foreground" });
      signal.addEventListener("abort", fail, { once: true });
      worker.child.stdin.write(JSON.stringify({ id, operation: "foreground" }) + "\n", (error) => {
        if (error) fail();
      });
    });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.starting?.catch(() => {});
    await Promise.all(
      [...this.workers].map(async (worker) => {
        worker.child.stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            worker.exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (this.workers.has(worker)) {
          this.retire(worker);
          try {
            await Promise.race([
              worker.exited,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Selection helper did not exit")), 2500);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
      }),
    );
  }

  private async capture(signal: AbortSignal, target: number): Promise<string> {
    let worker = await this.getWorker();
    if (signal.aborted) return "";
    if (worker.finish || worker.foreground) {
      this.retire(worker);
      worker = await this.getWorker();
      if (signal.aborted) return "";
    }
    const id = randomUUID();
    return new Promise<string>((resolve) => {
      const cancel = () => this.retire(worker);
      const timer = setTimeout(cancel, 2500);
      worker.finish = (text) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        worker.finish = undefined;
        resolve(signal.aborted ? "" : text);
      };
      this.requests.set(worker, { id, kind: "read" });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) return cancel();
      const request =
        target > 0 ? { id, operation: "read", targetWindow: target } : { id, operation: "read" };
      worker.child.stdin.write(JSON.stringify(request) + "\n", (error) => {
        if (error) this.retire(worker);
      });
    });
  }

  private readonly requests = new Map<
    SelectionWorker,
    { id: string; kind: "read" | "foreground" }
  >();

  private retire(worker: SelectionWorker): void {
    worker.active = false;
    if (this.worker === worker) this.worker = undefined;
    this.requests.delete(worker);
    worker.finish?.("");
    if (this.workers.has(worker)) worker.child.kill();
  }

  private getWorker(): Promise<SelectionWorker> {
    if (this.abort.signal.aborted) return Promise.reject(new Error("Selection reader stopped"));
    const worker = this.worker;
    if (worker?.active)
      return worker.ready.then(() => {
        if (!worker.active) throw new Error("Selection helper retired");
        return worker;
      });
    return (this.starting ??= this.startWorker().finally(() => {
      this.starting = undefined;
    }));
  }

  private async startWorker(): Promise<SelectionWorker> {
    const executable = await (this.executable ??= this.compile().catch((error: unknown) => {
      this.executable = undefined;
      throw error;
    }));
    if (this.abort.signal.aborted) throw new Error("Selection reader stopped");
    const child = spawn(executable, ["--server", String(process.pid)], {
      windowsHide: true,
      stdio: "pipe",
    });
    let ready!: () => void;
    let failed!: (error: Error) => void;
    let exited!: () => void;
    const worker: SelectionWorker = {
      child,
      active: true,
      ready: new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      }),
      exited: new Promise<void>((resolve) => {
        exited = resolve;
      }),
    };
    this.worker = worker;
    this.workers.add(worker);
    const timeout = setTimeout(() => fail(), 2500);
    const fail = () => {
      clearTimeout(timeout);
      failed(new Error("Selection helper unavailable"));
      this.retire(worker);
    };
    let readyReceived = false;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      if (!worker.active) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 262144) return fail();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (!readyReceived) {
            if (!z.strictObject({ ready: z.literal(true) }).safeParse(message).success)
              return fail();
            readyReceived = true;
            clearTimeout(timeout);
            ready();
          } else {
            const request = this.requests.get(worker);
            if (!request) return fail();
            if (request.kind === "read") {
              const result = selection.safeParse(message);
              if (!result.success || result.data.id !== request.id) return fail();
              this.requests.delete(worker);
              worker.finish?.(result.data.text);
            } else {
              const result = foreground.safeParse(message);
              if (!result.success || result.data.id !== request.id) return fail();
              this.requests.delete(worker);
              worker.foreground?.(result.data.window);
            }
          }
        } catch {
          return fail();
        }
      }
    });
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("close", () => {
      clearTimeout(timeout);
      worker.active = false;
      if (this.worker === worker) this.worker = undefined;
      this.requests.delete(worker);
      worker.finish?.("");
      failed(new Error("Selection helper exited"));
      this.workers.delete(worker);
      exited();
    });
    await worker.ready;
    return worker;
  }

  private async compile(): Promise<string> {
    if (process.platform !== "win32") throw new Error("Native selection requires Windows");
    const directory = this.options.cacheDirectory;
    fs.mkdirSync(directory, { recursive: true });
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Selection cache unavailable");
      if (path.dirname(current) === current) break;
    }
    const sourceFile = path.join(this.options.assetDirectory, "SelectionReader.cs");
    if (fs.lstatSync(sourceFile).isSymbolicLink()) throw new Error("Selection source unavailable");
    const source = fs.readFileSync(sourceFile);
    const hash = createHash("sha256").update(source).digest("hex");
    const executable = confined(directory, `selection-${hash}.exe`);
    const cachedSource = confined(directory, `selection-${hash}.cs`);
    if (fs.existsSync(executable)) {
      if (
        fs.lstatSync(executable).isSymbolicLink() ||
        !fs.statSync(executable).isFile() ||
        !fs.existsSync(cachedSource) ||
        fs.lstatSync(cachedSource).isSymbolicLink() ||
        !fs.readFileSync(cachedSource).equals(source)
      )
        throw new Error("Selection cache unavailable");
      return executable;
    }
    atomicWrite(cachedSource, source);
    const framework = path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
    );
    const temporary = confined(directory, `selection-${randomUUID()}.exe`);
    try {
      await new Promise<void>((resolve, reject) =>
        execFile(
          path.join(framework, "csc.exe"),
          [
            "/nologo",
            "/optimize+",
            "/target:exe",
            `/out:${temporary}`,
            "/reference:System.Web.Extensions.dll",
            `/reference:${path.join(framework, "WPF", "UIAutomationClient.dll")}`,
            `/reference:${path.join(framework, "WPF", "UIAutomationTypes.dll")}`,
            `/reference:${path.join(framework, "WPF", "WindowsBase.dll")}`,
            cachedSource,
          ],
          { windowsHide: true, timeout: 30000, maxBuffer: 65536, signal: this.abort.signal },
          (error) => (error ? reject(new Error("Selection helper compile failed")) : resolve()),
        ),
      );
      fs.renameSync(temporary, executable);
      return executable;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
