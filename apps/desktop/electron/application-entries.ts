import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError, canonical } from "./persistence.js";
import type {
  CustomApplicationEntry,
  CustomApplicationTarget,
} from "../src/features/applications/types.js";

const kindSchema = z.enum(["program", "shortcut", "document", "directory"]);
const entrySchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9-]{36}$/i),
  title: z.string().trim().min(1).max(160),
  path: z.string().min(1).max(32768),
  kind: kindSchema.optional(),
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((value) => !value.includes("\0")),
    )
    .max(64),
  cwd: z.string().max(32768),
});
// This is the host/Shell boundary's own check, independent of the plugin's
// settings validator. Documents cannot silently become executable targets.
const ordinaryDocuments = new Set(
  "txt md markdown rst csv tsv log json yaml yml toml ini xml doc docx odt rtf xls xlsx ods ppt pptx odp pdf png jpg jpeg gif webp bmp tif tiff ico heic avif".split(
    " ",
  ),
);
export function ordinaryDocument(location: string): boolean {
  return ordinaryDocuments.has(path.extname(location).slice(1).toLowerCase());
}
function validPath(location: string): boolean {
  return path.isAbsolute(location) && !/[\p{Cc}]/u.test(location);
}
export function classifyApplicationEntry(location: string): CustomApplicationTarget {
  if (!validPath(location)) throw new AppError("invalidApplication", "请选择本地文件或目录");
  const real = canonical(location);
  if (!validPath(real)) throw new AppError("invalidApplication", "目标真实路径不合法");
  const stat = fs.statSync(real);
  const kind = stat.isDirectory()
    ? "directory"
    : !stat.isFile()
      ? undefined
      : /\.exe$/i.test(real)
        ? "program"
        : /\.(?:lnk|url)$/i.test(real)
          ? "shortcut"
          : ordinaryDocument(real)
            ? "document"
            : undefined;
  if (!kind)
    throw new AppError(
      "invalidApplication",
      "脚本、安装包和未支持的文件类型请通过程序参数或快捷方式入口添加",
    );
  return { path: real, kind };
}
export function parseApplicationEntries(value: unknown): CustomApplicationEntry[] {
  const entries = z.array(entrySchema).max(200).parse(value);
  const ids = new Set<string>();
  return entries.map((entry) => {
    const kind =
      entry.kind ??
      (/\.exe$/i.test(entry.path)
        ? "program"
        : /\.(?:lnk|url)$/i.test(entry.path)
          ? "shortcut"
          : undefined);
    if (
      !kind ||
      ids.has(entry.id) ||
      !validPath(entry.path) ||
      (entry.cwd && !validPath(entry.cwd))
    )
      throw new AppError("invalidApplication", "入口标识、类型、路径或工作目录不合法");
    if (
      (kind === "program" && !/\.exe$/i.test(entry.path)) ||
      (kind === "shortcut" && !/\.(?:lnk|url)$/i.test(entry.path)) ||
      (kind === "document" && !ordinaryDocument(entry.path)) ||
      (kind !== "program" && (entry.args.length || entry.cwd)) ||
      entry.args.reduce((sum, value) => sum + value.length, 0) > 24000
    )
      throw new AppError("invalidApplication", "只有程序入口可以设置参数和工作目录");
    ids.add(entry.id);
    return {
      ...entry,
      kind,
      path: path.resolve(entry.path),
      cwd: entry.cwd ? path.resolve(entry.cwd) : "",
    };
  });
}
export function sameApplicationEntryPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

/** Exact points granted by the entry picker/drop bridge. Unlike FileGrants'
 * directory access, a directory shortcut never authorizes its descendants. */
export class ApplicationEntryAdmissions {
  private documents = new Map<string, Map<string, CustomApplicationTarget["kind"]>>();
  admit(caller: string, location: string, expected?: "directory"): CustomApplicationTarget {
    const target = classifyApplicationEntry(location);
    if (expected && target.kind !== expected)
      throw new AppError("invalidApplication", "请选择目录");
    const points = this.documents.get(caller) ?? new Map<string, CustomApplicationTarget["kind"]>();
    if (!points.has(target.path) && points.size >= 512) points.delete(points.keys().next().value!);
    points.set(target.path, target.kind);
    this.documents.set(caller, points);
    return target;
  }
  revoke(caller: string): void {
    this.documents.delete(caller);
  }
  validate(caller: string, currentValue: unknown, nextValue: unknown): CustomApplicationEntry[] {
    const current = new Map(
      parseApplicationEntries(currentValue).map((entry) => [entry.id, entry]),
    );
    return parseApplicationEntries(nextValue).map((entry) => {
      const previous = current.get(entry.id);
      const changed =
        !previous ||
        !sameApplicationEntryPath(previous.path, entry.path) ||
        previous.kind !== entry.kind;
      if (changed) {
        const target = classifyApplicationEntry(entry.path);
        if (
          target.kind !== entry.kind ||
          this.documents.get(caller)?.get(target.path) !== target.kind
        )
          throw new AppError("permissionDenied", "请通过入口选择器或拖放授权新目标");
        entry.path = target.path;
      }
      if (
        entry.cwd &&
        (!previous || !previous.cwd || !sameApplicationEntryPath(previous.cwd, entry.cwd))
      ) {
        const target = classifyApplicationEntry(entry.cwd);
        if (
          target.kind !== "directory" ||
          this.documents.get(caller)?.get(target.path) !== "directory"
        )
          throw new AppError("permissionDenied", "请通过选择器授权新的工作目录");
        entry.cwd = target.path;
      }
      return entry;
    });
  }
}
