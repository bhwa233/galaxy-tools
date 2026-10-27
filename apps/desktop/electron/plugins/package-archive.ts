import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import { isPluginPackagePath } from "@spark233/sdk";
import { limitPackageBytes } from "./package-io.js";

export interface PluginPackageLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxTarBytes: number;
  maxFileBytes: number;
  maxEntries: number;
  maxPathDepth: number;
}

export const DEFAULT_PLUGIN_PACKAGE_LIMITS: Readonly<PluginPackageLimits> = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxTarBytes: 768 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxPathDepth: 32,
});

export function packageLimits(options: Partial<PluginPackageLimits> = {}): PluginPackageLimits {
  const limits = { ...DEFAULT_PLUGIN_PACKAGE_LIMITS, ...options };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Plugin package limits must be positive safe integers");
  }
  return limits;
}

/** Validate the complete archive before allowing tar to write any entries. */
export async function extractPluginArchive(
  archive: string,
  destination: string,
  limits: PluginPackageLimits,
  signal?: AbortSignal,
): Promise<void> {
  const tarFile = path.join(path.dirname(archive), "validated-package.tar");
  await pipeline(
    createReadStream(archive),
    createGunzip(),
    limitPackageBytes(limits.maxTarBytes, "Uncompressed tar stream"),
    createWriteStream(tarFile, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  const paths = new Map<string, { spelling: string; directory: boolean; explicit: boolean }>();
  let entries = 0;
  let expanded = 0;
  let invalid: Error | undefined;
  const reject = (message: string) => {
    invalid ??= new Error(message);
  };
  const parser = new tar.Parser({
    strict: true,
    preservePaths: false,
    maxMetaEntrySize: 1024 * 1024,
    onwarn: (code, message) => reject(`Rejected tar warning ${code}: ${message}`),
    onReadEntry: (entry) => {
      if (invalid) {
        entry.resume();
        return;
      }
      try {
        signal?.throwIfAborted();
        if (++entries > limits.maxEntries)
          throw new Error("Plugin archive contains too many entries");
        const directory = entry.type === "Directory";
        if (!directory && entry.type !== "File" && entry.type !== "OldFile") {
          throw new Error(`Plugin archive entry type is forbidden: ${entry.type}`);
        }
        const name = directory && entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
        if (entry.header.path?.includes("\\"))
          throw new Error("Backslash archive paths are forbidden");
        if (!isPluginPackagePath(name) || (name !== "package" && !name.startsWith("package/"))) {
          throw new Error(`Unsafe plugin archive path: ${entry.path}`);
        }
        if (name === "package" && !directory)
          throw new Error("The npm package root must be a directory");
        const parts = name.split("/");
        if (parts.length > limits.maxPathDepth) throw new Error("Plugin archive path is too deep");
        if (parts.some((part) => part.length > 255))
          throw new Error("Plugin archive path component is too long");
        if (
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          entry.size > limits.maxFileBytes
        ) {
          throw new Error("Plugin archive entry exceeds the file size limit");
        }
        expanded += entry.size;
        if (expanded > limits.maxExpandedBytes)
          throw new Error("Plugin archive exceeds the expanded size limit");
        for (let i = 1; i <= parts.length; i++) {
          const spelling = parts.slice(0, i).join("/");
          const key = spelling.normalize("NFC").toUpperCase();
          const leaf = i === parts.length;
          const previous = paths.get(key);
          if (
            previous &&
            (previous.spelling !== spelling ||
              !previous.directory ||
              (leaf && (!directory || previous.explicit)))
          ) {
            throw new Error(`Duplicate, case-colliding or conflicting plugin path: ${spelling}`);
          }
          paths.set(key, {
            spelling,
            directory: leaf ? directory : true,
            explicit: previous?.explicit || leaf,
          });
        }
      } catch (error) {
        invalid = error instanceof Error ? error : new Error(String(error));
      } finally {
        entry.resume();
      }
    },
  });
  parser.on("ignoredEntry", () =>
    reject("Plugin archive contains an ignored or unsupported entry"),
  );
  parser.on("meta", () => {
    if (++entries > limits.maxEntries) reject("Plugin archive contains too many entries");
  });
  const abort = () =>
    parser.abort(
      signal?.reason instanceof Error ? signal.reason : new Error("Plugin archive cancelled"),
    );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await pipeline(createReadStream(tarFile), parser, { signal });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  if (invalid) throw invalid;
  const manifest = paths.get("PACKAGE/PACKAGE.JSON");
  if (!manifest || manifest.directory || manifest.spelling !== "package/package.json") {
    throw new Error("Plugin archive is missing package/package.json");
  }
  await tar.x({
    file: tarFile,
    cwd: destination,
    strip: 1,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    forceChown: false,
    noMtime: true,
    onwarn: (code, message) => reject(`Rejected tar extraction warning ${code}: ${message}`),
  });
  signal?.throwIfAborted();
  if (invalid) throw invalid;
}
