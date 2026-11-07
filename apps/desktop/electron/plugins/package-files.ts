import fs from "node:fs";
import path from "node:path";
import { isPluginPackagePath } from "@spark233/sdk";
import { confined, inside } from "../persistence.js";

/** Content types for files a plugin package may serve to its own pages. */
export const PACKAGE_MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface PackageFilePolicy {
  /** Extensions this surface serves; each must also have a known content type. */
  extensions: readonly string[];
  maxBytes: (extension: string) => number;
  /** Reject a literal "%" after decoding, so double-encoded paths never resolve. */
  rejectPercent?: boolean;
}

/**
 * Resolve a URL path to a regular file inside a plugin package. Both the page
 * host and the widget host serve package files; they differ only in policy
 * (types, size, headers), so the path and containment checks live here once.
 */
export function resolvePackageFile(
  root: string,
  pathname: string,
  policy: PackageFilePolicy,
): { file: string; mime: string } | undefined {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).slice(1);
  } catch {
    return undefined;
  }
  if (!isPluginPackagePath(relative) || (policy.rejectPercent && relative.includes("%")))
    return undefined;
  try {
    const file = confined(root, relative);
    if (!inside(fs.realpathSync(root), fs.realpathSync(file))) return undefined;
    const extension = path.extname(file).toLowerCase();
    const mime = PACKAGE_MIME[extension];
    if (!mime || !policy.extensions.includes(extension)) return undefined;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > policy.maxBytes(extension)) return undefined;
    return { file, mime };
  } catch {
    return undefined;
  }
}
