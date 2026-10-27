import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const admittedExtensions = [
  "txt",
  "md",
  "markdown",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "config",
  "xml",
  "html",
  "css",
  "scss",
  "less",
  "py",
  "rs",
  "go",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "java",
  "kt",
  "swift",
  "rb",
  "php",
  "sql",
  "sh",
  "ps1",
  "bat",
  "cmd",
  "vue",
  "svelte",
  "log",
  "csv",
] as const;
export const settingsSchema = z.strictObject({
  excludedRoots: z.array(z.string().trim().min(1).max(32768)).max(128),
  extensions: z.array(z.enum(admittedExtensions)).max(64).default([]),
  maxFileMiB: z.number().int().min(1).max(64).default(64),
  includeHidden: z.boolean().default(false),
});
export function validateSettings(value: unknown): z.infer<typeof settingsSchema> {
  const parsed = settingsSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 256 * 1024)
    throw new Error("Search settings exceed the bounded native request budget");
  const roots = new Map<string, string>();
  for (const value of parsed.excludedRoots) {
    const windowsPath = value.replaceAll("/", "\\");
    if (
      value.includes("\0") ||
      !path.isAbsolute(value) ||
      (!/^[a-z]:\\/i.test(windowsPath) && !/^\\\\[^\\?.][^\\]*\\[^\\]+/.test(windowsPath)) ||
      windowsPath.startsWith("\\\\?\\") ||
      windowsPath.startsWith("\\\\.\\")
    )
      throw new Error("Search exclusions must be absolute directory or volume paths");
    const normalized = path.resolve(value);
    if (fs.existsSync(normalized) && !fs.statSync(normalized).isDirectory())
      throw new Error("Search exclusions must refer to directories or volumes");
    roots.set(normalized.toLowerCase(), normalized);
  }
  return {
    ...parsed,
    excludedRoots: [...roots.values()],
    extensions: [...new Set(parsed.extensions)],
  };
}
