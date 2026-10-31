import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { create, extract } from "tar";

/**
 * Prebuilt native payloads keep the development environment free of MSVC,
 * CMake, Ninja, PowerShell 7 and OpenCV/ONNX. CI builds the five native
 * plugins once, packs their staged outputs, and developers fetch the pack
 * instead of compiling it. Everything here is repository-relative so a pack
 * produced on a CI runner lands at the same paths locally.
 */
const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultOut = path.join(project, "local-build/native-payloads");
const stampName = "native-payloads.json";
const allowed = [
  /^packages\/official\/(?:screenshot|ocr|clipboard|applications|search)\/native\//,
];
const roots = [
  "packages/official/screenshot/native",
  "packages/official/ocr/native",
  "packages/official/clipboard/native",
  "packages/official/applications/native",
  "packages/official/search/native",
];
const hash = (content) => createHash("sha256").update(content).digest("hex");
function assertRelative(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value))
    throw new Error(`Native payload entry must be repository-relative: ${value}`);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..") || normalized !== path.posix.normalize(normalized))
    throw new Error(`Native payload entry escapes the repository: ${value}`);
  if (!allowed.some((pattern) => pattern.test(normalized)))
    throw new Error(`Native payload entry is outside the managed roots: ${value}`);
  return normalized;
}
async function walk(directory, collected) {
  const entries = await fs.readdir(path.join(project, directory), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Native payload tree has a symlink: ${entry.name}`);
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) await walk(relative, collected);
    else if (entry.isFile()) collected.push(relative);
  }
}
async function collect() {
  const collected = [];
  for (const root of roots) {
    try {
      await fs.access(path.join(project, root));
      await walk(root, collected);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return collected;
}
async function describe(files) {
  const manifest = [];
  for (const relative of files) {
    const content = await fs.readFile(path.join(project, relative));
    manifest.push({ path: relative, bytes: content.length, sha256: hash(content) });
  }
  return manifest;
}
function readManifest(value) {
  if (value?.schemaVersion !== 1) throw new Error("Unsupported native payload manifest");
  if (!value.bundle || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(value.bundle.name))
    throw new Error("Manifest has no usable bundle name");
  if (!Number.isSafeInteger(value.bundle.bytes) || !/^[a-f0-9]{64}$/i.test(value.bundle.sha256))
    throw new Error("Manifest has no usable bundle integrity");
  if (!Array.isArray(value.files) || !value.files.length) throw new Error("Manifest has no files");
  const files = value.files.map((entry) => {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0)
      throw new Error(`Invalid native payload size: ${entry.path}`);
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256))
      throw new Error(`Invalid native payload hash: ${entry.path}`);
    return { path: assertRelative(entry.path), bytes: entry.bytes, sha256: entry.sha256 };
  });
  if (new Set(files.map((entry) => entry.path.toLowerCase())).size !== files.length)
    throw new Error("Native payload manifest repeats a file");
  return { ...value, files };
}
async function pack({ out }) {
  const files = await collect();
  if (!files.length)
    throw new Error(
      "No native payloads found. Build the plugins on Windows before packing: pwsh -File scripts/prepare-windows-resources.ps1",
    );
  const manifest = await describe(files);
  await fs.mkdir(out, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  const bundleName = `spark233-native-payloads-${commit.slice(0, 12)}.tar.gz`;
  const bundlePath = path.join(out, bundleName);
  await create({ gzip: true, file: bundlePath, cwd: project, portable: true }, files);
  const content = await fs.readFile(bundlePath);
  const payload = {
    schemaVersion: 1,
    commit,
    createdAt: new Date().toISOString(),
    bundle: { name: bundleName, bytes: content.length, sha256: hash(content) },
    files: manifest,
  };
  const manifestPath = path.join(out, stampName);
  await fs.writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Packed ${files.length} native payload files (${content.length} bytes)`);
  console.log(manifestPath);
  console.log(bundlePath);
  return { manifestPath, bundlePath };
}
async function readSource(from, name) {
  if (/^https?:\/\//i.test(from)) {
    const response = await fetch(new URL(name, from.endsWith("/") ? from : `${from}/`));
    if (!response.ok) throw new Error(`Native payload download failed: ${response.status} ${name}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFile(path.join(from, name));
}
async function fetchPayloads({ from, out }) {
  const manifest = readManifest(JSON.parse((await readSource(from, stampName)).toString("utf8")));
  const bundle = await readSource(from, manifest.bundle.name);
  if (bundle.length !== manifest.bundle.bytes || hash(bundle) !== manifest.bundle.sha256)
    throw new Error("Native payload bundle does not match its manifest");
  const staging = path.join(out, `staging-${process.pid}-${Date.now()}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  const bundlePath = path.join(staging, manifest.bundle.name);
  await fs.writeFile(bundlePath, bundle);
  try {
    await extract({ file: bundlePath, cwd: staging, strict: true });
    for (const entry of manifest.files) {
      const source = path.join(staging, ...entry.path.split("/"));
      const content = await fs.readFile(source);
      if (content.length !== entry.bytes || hash(content) !== entry.sha256)
        throw new Error(`Native payload file does not match the manifest: ${entry.path}`);
      const target = path.join(project, ...entry.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, stampName),
      `${JSON.stringify({ ...manifest, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  console.log(`Installed ${manifest.files.length} native payload files from ${from}`);
}
async function check({ quiet } = {}) {
  const stampPath = path.join(defaultOut, stampName);
  let stamp;
  try {
    stamp = JSON.parse(await fs.readFile(stampPath, "utf8"));
  } catch {
    if (!quiet) console.log("No native payload stamp. Run pnpm native:fetch or build the plugins locally.");
    return false;
  }
  for (const entry of readManifest(stamp).files) {
    let content;
    try {
      content = await fs.readFile(path.join(project, ...entry.path.split("/")));
    } catch {
      if (!quiet) console.log(`Missing native payload: ${entry.path}`);
      return false;
    }
    if (content.length !== entry.bytes || hash(content) !== entry.sha256) {
      if (!quiet) console.log(`Native payload changed: ${entry.path}`);
      return false;
    }
  }
  if (!quiet) console.log(`Native payloads verified (${stamp.files.length} files, ${stamp.commit})`);
  return true;
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, from: { type: "string" }, quiet: { type: "boolean" } },
});
const command = positionals[0];
const out = path.resolve(project, values.out ?? defaultOut);
if (command === "pack") await pack({ out });
else if (command === "fetch") {
  if (!values.from) throw new Error("Supply --from with a release URL or a packed directory");
  await fetchPayloads({ from: values.from, out });
  await check();
} else if (command === "check") process.exitCode = (await check()) ? 0 : 1;
else if (command === "has") process.exitCode = (await check({ quiet: true })) ? 0 : 1;
else {
  console.log("Usage: node scripts/native-payloads.mjs <pack|fetch|check|has> [--out <dir>] [--from <url|dir>]");
  process.exitCode = 1;
}
