import fs from "node:fs";
import path from "node:path";
import { AppError, canonical, inside } from "./store.js";

/** Paths outside application storage need a native dialog, actual dropped File, or CLI grant. */
export class FileGrants {
  private files = new Set<string>();
  private directories = new Set<string>();
  grant(file: string, directory = false): void {
    (directory ? this.directories : this.files).add(canonical(file));
  }
  allows(file: string): boolean {
    const target = canonical(file);
    return this.files.has(target) || [...this.directories].some((dir) => inside(dir, target));
  }
  assert(file: unknown, extensions?: RegExp): string {
    if (
      typeof file !== "string" ||
      !path.isAbsolute(file) ||
      !this.allows(file) ||
      (extensions && !extensions.test(file))
    )
      throw new AppError("permissionDenied", "请通过文件选择器或拖放授权此文件");
    return file;
  }
}
export function imagePath(dataDir: string, candidate: string, background?: string): string {
  const target = canonical(candidate);
  if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(target))
    throw new AppError("permissionDenied", "仅允许加载图片资源");
  const roots = [path.join(dataDir, "images"), path.join(dataDir, "backgrounds")];
  if (
    !roots.some((root) => inside(canonical(root), target)) &&
    (!background || target !== canonical(background))
  )
    throw new AppError("permissionDenied", "资源超出图片目录");
  if (!fs.statSync(target).isFile()) throw new AppError("permissionDenied", "资源不是文件");
  return target;
}
export function externalUrl(value: unknown): string {
  if (typeof value !== "string") throw new AppError("invalidPayload", "链接不合法");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new AppError("permissionDenied", "只允许打开 HTTP/HTTPS 链接");
  return url.href;
}
