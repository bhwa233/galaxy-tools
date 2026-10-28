import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { settingsSchema } from "../../../shared/search-schema.js";

export { settingsSchema } from "../../../shared/search-schema.js";
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
