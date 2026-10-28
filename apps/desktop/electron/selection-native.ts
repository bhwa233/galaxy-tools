import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, confined } from "./persistence.js";

const selection = z.strictObject({
  text: z
    .string()
    .max(65536)
    .refine((text) => Buffer.byteLength(text, "utf8") <= 65536),
});

/** Reuses windows-runtime's in-box compiler and the host's cache primitives.
 * Electron has no external-app selection API. This helper only reads UIA;
 * it installs no hooks and never accesses the clipboard or sends input. */
export class NativeSelectionReader {
  private executable?: Promise<string>;
  private readonly pending = new Set<Promise<string>>();
  private readonly abort = new AbortController();

  constructor(private readonly options: { assetDirectory: string; cacheDirectory: string }) {}

  prepare(): Promise<string> {
    return (this.executable ??= this.compile().catch((error: unknown) => {
      this.executable = undefined;
      throw error;
    }));
  }

  async read(signal: AbortSignal): Promise<string> {
    if (process.platform !== "win32" || signal.aborted || this.abort.signal.aborted) return "";
    const work = this.capture(AbortSignal.any([signal, this.abort.signal]));
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.pending, ...(this.executable ? [this.executable] : [])]);
  }

  private async capture(signal: AbortSignal): Promise<string> {
    const executable = await this.prepare();
    if (signal.aborted) return "";
    return new Promise<string>((resolve) => {
      execFile(
        executable,
        [String(process.pid)],
        {
          windowsHide: true,
          encoding: "utf8",
          timeout: 2500,
          maxBuffer: 262144,
          signal,
        },
        (error, stdout) => {
          if (error || signal.aborted) return resolve("");
          try {
            const result = selection.safeParse(JSON.parse(stdout));
            resolve(result.success ? result.data.text : "");
          } catch {
            resolve("");
          }
        },
      );
    });
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
