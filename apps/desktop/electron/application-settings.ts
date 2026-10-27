import fs from "node:fs";
import { createHash } from "node:crypto";
import { parseApplicationEntries } from "./application-entries.js";
import { AppError } from "./persistence.js";

/** Offline configuration reuses the host target validator, without running a
 * disabled plugin or granting any paths merely because they are persisted. */
export function readApplicationSettings(file: string, identity: string) {
  let entries: ReturnType<typeof parseApplicationEntries> = [];
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      throw new AppError("invalidApplication", "应用配置文件不合法");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.version !== 2) throw new AppError("invalidApplication", "应用配置版本不受支持");
    entries = parseApplicationEntries(value.entries);
  }
  return {
    entries,
    supportedKinds: ["program", "shortcut", "document", "directory"],
    revision: createHash("sha256")
      .update(JSON.stringify([identity, entries]))
      .digest("hex"),
  };
}
