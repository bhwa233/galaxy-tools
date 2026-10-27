/* eslint-disable no-control-regex -- Reject control characters in persisted Windows paths. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const SUPPORTED_KINDS = Object.freeze(["program", "shortcut", "document", "directory"]);
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const ordinaryDocuments = new Set(
  "txt md markdown rst csv tsv log json yaml yml toml ini xml doc docx odt rtf xls xlsx ods ppt pptx odp pdf png jpg jpeg gif webp bmp tif tiff ico heic avif".split(
    " ",
  ),
);

export function isDocumentPath(filename) {
  return ordinaryDocuments.has(path.extname(filename).slice(1).toLowerCase());
}

function pathMatchesKind(kind, filename) {
  if (kind === "program") return /\.exe$/i.test(filename);
  if (kind === "shortcut") return /\.(?:lnk|url)$/i.test(filename);
  return kind === "directory" || isDocumentPath(filename);
}

/** Shared by the standalone backend and migration; never inspect a target here.
 * Host persistence/schema helpers are unavailable inside the independent npm package. */
export function validateEntries(value) {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error("Custom applications must be a list of at most 200 entries");
  const ids = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid custom application entry");
    const kind =
      entry.kind === undefined
        ? typeof entry.path === "string" && /\.exe$/i.test(entry.path)
          ? "program"
          : typeof entry.path === "string" && /\.(?:lnk|url)$/i.test(entry.path)
            ? "shortcut"
            : undefined
        : entry.kind;
    if (
      typeof entry.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.title !== "string" ||
      !entry.title.trim() ||
      entry.title.length > 160 ||
      !SUPPORTED_KINDS.includes(kind) ||
      typeof entry.path !== "string" ||
      !path.isAbsolute(entry.path) ||
      entry.path.length > 32768 ||
      /[\x00-\x1f]/.test(entry.path) ||
      !pathMatchesKind(kind, entry.path) ||
      !Array.isArray(entry.args) ||
      entry.args.length > 64 ||
      entry.args.some(
        (argument) =>
          typeof argument !== "string" || argument.length > 4096 || argument.includes("\0"),
      ) ||
      entry.args.reduce((length, argument) => length + argument.length, 0) > 24000 ||
      typeof entry.cwd !== "string" ||
      entry.cwd.length > 32768 ||
      /[\x00-\x1f]/.test(entry.cwd) ||
      (entry.cwd && !path.isAbsolute(entry.cwd)) ||
      (kind !== "program" && (entry.args.length || entry.cwd))
    )
      throw new Error("Invalid custom target kind, name, path, arguments, or working directory");
    ids.add(entry.id);
    return {
      id: entry.id,
      kind,
      title: entry.title.trim(),
      path: path.resolve(entry.path),
      args: [...entry.args],
      cwd: entry.cwd ? path.resolve(entry.cwd) : "",
    };
  });
}

export async function readSettingsFile(filename) {
  try {
    const metadata = await fs.lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SETTINGS_BYTES)
      throw new Error("Custom application settings are not a bounded regular file");
    const bytes = await fs.readFile(filename);
    if (bytes.length > MAX_SETTINGS_BYTES)
      throw new Error("Custom application settings are too large");
    const saved = JSON.parse(bytes.toString("utf8"));
    if (!saved || ![1, 2].includes(saved.version))
      throw new Error("Unknown custom application settings version");
    const entries = validateEntries(saved.entries);
    if (
      saved.version === 1 &&
      entries.some((entry) => ["document", "directory"].includes(entry.kind))
    )
      throw new Error("Legacy custom application data cannot contain document/directory entries");
    return { version: saved.version, entries };
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

export async function writeSettingsFile(filename, entries, signal) {
  const next = validateEntries(entries);
  const serialized = JSON.stringify({ version: 2, entries: next }, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES)
    throw new Error("Custom application settings are too large");
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await fs.open(temporary, "wx", 0o600);
    await file.writeFile(serialized);
    await file.sync();
    await file.close();
    file = undefined;
    signal?.throwIfAborted();
    await fs.rename(temporary, filename);
  } finally {
    await file?.close();
    await fs.rm(temporary, { force: true });
  }
}

/** Metadata only: never enumerate a directory or read document/program bytes. */
export async function assertEntryTarget(entry, signal) {
  signal?.throwIfAborted();
  const resolved = await fs.realpath(entry.path);
  if (entry.kind === "document" || entry.kind === "directory") {
    const point = (value) =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (point(resolved) !== point(entry.path))
      throw new Error("Custom target moved or was redirected; choose it again");
  }
  const metadata = await fs.stat(resolved);
  if (
    (entry.kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) ||
    !pathMatchesKind(entry.kind, resolved)
  )
    throw new Error("Custom target is unavailable or its type changed");
  if (entry.kind === "program" && entry.cwd) {
    const cwd = await fs.realpath(entry.cwd);
    if (!(await fs.stat(cwd)).isDirectory())
      throw new Error("Program working directory is unavailable");
  }
  signal?.throwIfAborted();
}
