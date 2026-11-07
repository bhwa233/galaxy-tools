import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function atomicWrite(file: string, value: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetry(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
/** Windows refuses to replace a file that Defender, the search indexer or a
 * backup tool holds open for a moment. Retry briefly instead of failing the save. */
function renameWithRetry(from: string, to: string): void {
  const transient = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !transient.has(code) || attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
    }
  }
}
export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
// Resolve existing ancestors too: lexical prefix checks alone permit symlink/junction escapes.
export function canonical(file: string): string {
  const absolute = path.resolve(file);
  // Match fs.promises.realpath on Windows, including expansion of 8.3 aliases.
  // The JS sync implementation retains aliases and breaks identity after restore.
  if (fs.existsSync(absolute)) return fs.realpathSync.native(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
}
export function confined(root: string, ...parts: string[]): string {
  const file = path.resolve(root, ...parts);
  if (!inside(path.resolve(root), file) || !inside(canonical(root), canonical(file)))
    throw new AppError("unsafePath", "路径超出授权目录");
  return file;
}
