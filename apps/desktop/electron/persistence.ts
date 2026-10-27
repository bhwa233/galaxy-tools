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
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
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
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
}
export function confined(root: string, ...parts: string[]): string {
  const file = path.resolve(root, ...parts);
  if (!inside(path.resolve(root), file) || !inside(canonical(root), canonical(file)))
    throw new AppError("unsafePath", "路径超出授权目录");
  return file;
}
