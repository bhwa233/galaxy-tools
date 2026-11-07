// Stages the official Everything 1.5 portable x64 build into the search plugin.
//
//   node scripts/native-everything/stage.mjs [--zip <downloaded.zip>]
//
// Without --zip the archive is downloaded into a new empty directory under
// local-build/untrusted/. The archive and every staged file must match
// sources.lock.json; nothing from the archive is executed here.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const project = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const lock = JSON.parse(
  await fs.readFile(path.join(project, "scripts/native-everything/sources.lock.json"), "utf8"),
).everything;
const target = path.join(project, "packages/official/search/native");
const { values } = parseArgs({ options: { zip: { type: "string" } } });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download() {
  const directory = path.join(
    project,
    "local-build/untrusted",
    `everything-${lock.version}-${Date.now()}`,
  );
  await fs.mkdir(directory, { recursive: true });
  const response = await fetch(lock.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${lock.url}`);
  const file = path.join(directory, path.posix.basename(new URL(lock.url).pathname));
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

/** Minimal reader for the two-entry voidtools archive (stored or deflated). */
function readZip(archive) {
  let end = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65557); index--)
    if (archive.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  if (end < 0) throw new Error("Not a zip archive");
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad zip directory");
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error("Bad zip entry");
    const start =
      local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(start, start + compressed);
    const data =
      method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : undefined;
    if (!data || data.length !== size) throw new Error(`Unsupported zip entry: ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const archivePath = values.zip ? path.resolve(values.zip) : await download();
const archive = await fs.readFile(archivePath);
if (sha256(archive) !== lock.sha256)
  throw new Error(`Everything archive SHA-256 mismatch: ${archivePath}`);
const entries = readZip(archive);
await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
const files = [];
for (const expected of lock.files) {
  const data = entries.get(expected.name);
  if (!data || data.length !== expected.bytes || sha256(data) !== expected.sha256)
    throw new Error(`Everything archive entry does not match the lock: ${expected.name}`);
  await fs.writeFile(path.join(target, expected.name), data);
  files.push({ name: expected.name, bytes: data.length, sha256: expected.sha256 });
}
await fs.writeFile(
  path.join(target, "resources.json"),
  `${JSON.stringify(
    {
      protocol: 1,
      files,
      upstream: {
        product: "Everything",
        version: lock.version,
        url: lock.url,
        sha256: lock.sha256,
        signer: lock.signer,
        license: "licenses/Everything/License.txt",
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`Staged Everything ${lock.version} into ${path.relative(project, target)}`);
