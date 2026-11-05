import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { open, mkdir, stat } from "node:fs/promises";
import { createDecipheriv, createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getRawHeader, extractFile, uncache } from "@electron/asar";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { isPluginPackagePath } from "@spark233/sdk";
import { limitPackageBytes } from "./package-io.js";
import type { PluginPackageLimits } from "./package-archive.js";
import { upxsProfile } from "./utools-upxs-profile.js";

const maxHeader = 1024 * 1024;
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function decryptMetadata(kind: "header" | "check", bytes: Uint8Array): Buffer {
  const profile = upxsProfile[kind];
  try {
    return Buffer.from(
      xchacha20poly1305(Buffer.from(profile.key, "hex"), Buffer.from(profile.nonce, "hex")).decrypt(
        bytes,
      ),
    );
  } catch {
    throw new Error("当前版本不支持此 UPXS 包，或包的认证数据已损坏");
  }
}

/** tar covers npm packages; Electron's ASAR reader and noble cover these two
 * containers. This adapter adds host budgets, path/identity checks and private
 * extraction; it never loads an addon, preload or package script. */
export async function extractUToolsArchive(
  archive: string,
  destination: string,
  limits: PluginPackageLimits,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const info = await stat(archive);
  if (!info.isFile() || info.size < 16 || info.size > limits.maxArchiveBytes)
    throw new Error("uTools 插件包大小无效或超限");
  const file = await open(archive, "r");
  // Electron treats .asar paths as virtual directories; raw payloads must use
  // a plain filename so the official ASAR reader can open their bytes.
  let source = archive;
  let packageId: string | undefined;
  try {
    const head = Buffer.alloc(16);
    if ((await file.read(head, 0, head.length, 0)).bytesRead !== head.length)
      throw new Error("uTools 包已截断");
    if (head[0] === 0x1f && head[1] === 0x8b && head[2] === 8) {
      source = path.join(path.dirname(archive), "utools-payload.bin");
      await pipeline(
        createReadStream(archive),
        createGunzip(),
        limitPackageBytes(limits.maxTarBytes, "uTools ASAR"),
        createWriteStream(source, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    } else if (head.readUInt32LE(0) !== 4) {
      const length = head.readUInt32LE(0);
      if (
        length < 16 ||
        length > maxHeader ||
        length + 4 >= info.size ||
        (info.size - length - 4) % 16
      )
        throw new Error("无法识别的 uTools 包格式");
      const header = Buffer.alloc(length);
      if ((await file.read(header, 0, length, 4)).bytesRead !== length)
        throw new Error("UPXS 元数据已截断");
      const metadata: unknown = JSON.parse(decryptMetadata("header", header).toString("utf8"));
      if (
        !object(metadata) ||
        (metadata.serverDecrypt !== undefined && metadata.serverDecrypt !== false) ||
        typeof metadata.key !== "string" ||
        !/^[a-f0-9]{64}$/i.test(metadata.key) ||
        typeof metadata.iv !== "string" ||
        !/^[a-f0-9]{32}$/i.test(metadata.iv) ||
        !Number.isSafeInteger(metadata.timestamp) ||
        metadata.timestamp <= 0
      )
        throw new Error("不支持此 UPXS 元数据或所需平台服务");
      if (Object.hasOwn(metadata, "pluginId") || Object.hasOwn(metadata, "encrypt2")) {
        // A partial identity extension must never fall back to the legacy layout.
        if (
          typeof metadata.pluginId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,160}$/.test(metadata.pluginId) ||
          typeof metadata.encrypt2 !== "string" ||
          !/^(?:[a-f0-9]{2}){16,512}$/i.test(metadata.encrypt2)
        )
          throw new Error("UPXS 插件身份元数据不完整或无效");
        if (
          decryptMetadata("check", Buffer.from(metadata.encrypt2, "hex")).toString("utf8") !==
          metadata.pluginId + String(metadata.timestamp)
        )
          throw new Error("UPXS 插件身份校验失败");
        packageId = metadata.pluginId;
      } else if (
        Object.keys(metadata).some(
          (key) =>
            !["key", "iv", "timestamp", "serverDecrypt", "os", "app", "developer"].includes(key),
        ) ||
        ["os", "app", "developer"].some(
          (key) => Object.hasOwn(metadata, key) && !object(metadata[key]),
        )
      )
        throw new Error("不支持此 UPXS 元数据格式");
      source = path.join(path.dirname(archive), "utools-payload.bin");
      await pipeline(
        createReadStream(archive, { start: 4 + length }),
        createDecipheriv(
          "aes-256-cbc",
          Buffer.from(metadata.key, "hex"),
          Buffer.from(metadata.iv, "hex"),
        ),
        createGunzip(),
        limitPackageBytes(limits.maxTarBytes, "uTools ASAR"),
        createWriteStream(source, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    }
  } finally {
    await file.close();
  }

  const asarInfo = await stat(source);
  if (asarInfo.size > limits.maxTarBytes) throw new Error("uTools ASAR 超出大小限制");
  // Bound the Pickle header before asking ASAR to allocate/read its JSON.
  const asar = await open(source, "r");
  try {
    const head = Buffer.alloc(16);
    if (
      (await asar.read(head, 0, 16, 0)).bytesRead !== 16 ||
      head.readUInt32LE(0) !== 4 ||
      head.readUInt32LE(4) < 8 ||
      head.readUInt32LE(4) > 8 * maxHeader ||
      head.readUInt32LE(4) % 4 ||
      head.readUInt32LE(8) !== head.readUInt32LE(4) - 4 ||
      head.readUInt32LE(12) > head.readUInt32LE(4) - 8 ||
      8 + head.readUInt32LE(4) > asarInfo.size
    )
      throw new Error("无效的 ASAR 头部");
  } finally {
    await asar.close();
  }
  const { header, headerSize } = getRawHeader(source);
  const names = new Set<string>();
  const files: Array<{ name: string; entry: Record<string, any> }> = [];
  let count = 0,
    expanded = 0;
  const walk = (node: unknown, parents: string[]) => {
    signal?.throwIfAborted();
    if (!object(node) || !object(node.files) || parents.length >= limits.maxPathDepth)
      throw new Error("无效或过深的 ASAR 目录");
    for (const [part, entry] of Object.entries(node.files)) {
      const name = [...parents, part].join("/");
      const key = name.normalize("NFC").toUpperCase();
      if (
        ++count > limits.maxEntries ||
        !isPluginPackagePath(name) ||
        part.includes("/") ||
        part.length > 255 ||
        names.has(key)
      )
        throw new Error("ASAR 路径不安全、重复或数量超限");
      names.add(key);
      if (!object(entry) || Object.hasOwn(entry, "link") || entry.unpacked)
        throw new Error("uTools 包不支持链接或包外文件");
      if (Object.hasOwn(entry, "files")) {
        walk(entry, [...parents, part]);
        continue;
      }
      if (
        typeof entry.offset !== "string" ||
        !/^\d+$/.test(entry.offset) ||
        !Number.isSafeInteger(Number(entry.offset)) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > limits.maxFileBytes ||
        !Number.isSafeInteger(8 + headerSize + Number(entry.offset) + entry.size) ||
        8 + headerSize + Number(entry.offset) + entry.size > asarInfo.size
      )
        throw new Error("ASAR 文件大小或偏移无效");
      expanded += entry.size;
      if (expanded > limits.maxExpandedBytes) throw new Error("uTools 插件解包体积超限");
      files.push({ name, entry });
    }
  };
  walk(header, []);
  const manifest = files.find((candidate) => candidate.name === "plugin.json");
  if (!manifest || manifest.entry.size > 128 * 1024)
    throw new Error("uTools 包缺少有界的 plugin.json");
  const warnings: string[] = [];
  try {
    const parsed = JSON.parse(extractFile(source, "plugin.json", false).toString("utf8"));
    if (!object(parsed) || (packageId && parsed.name !== packageId))
      throw new Error("uTools 清单与包身份不一致");
    // Validate all names/ranges above before creating any package-controlled path.
    for (const { name, entry } of files) {
      signal?.throwIfAborted();
      if (entry.integrity) {
        const integrity = entry.integrity;
        if (
          !object(integrity) ||
          integrity.algorithm !== "SHA256" ||
          typeof integrity.hash !== "string" ||
          !/^[a-f0-9]{64}$/i.test(integrity.hash)
        )
          throw new Error("ASAR 完整性记录无效");
      }
      const target = path.join(destination, ...name.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const digest = createHash("sha256");
      let received = 0;
      const start = 8 + headerSize + Number(entry.offset);
      const input = entry.size
        ? createReadStream(source, { start, end: start + entry.size - 1 })
        : Readable.from([]);
      await pipeline(
        input,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            received += chunk.length;
            digest.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(target, { flags: "wx", mode: entry.executable ? 0o700 : 0o600 }),
        { signal },
      );
      if (received !== entry.size) throw new Error("ASAR 内容已截断: " + name);
      if (entry.integrity && digest.digest("hex") !== entry.integrity.hash.toLowerCase()) {
        // Official exports can rewrite only plugin.json without refreshing its
        // ASAR record. Preserve this discrepancy in the confirmation preview.
        if (name !== "plugin.json") throw new Error("ASAR 内容校验失败: " + name);
        warnings.push("上游包的清单校验记录与内容不一致，请在安装确认中核对插件身份与来源。");
      }
    }
  } finally {
    uncache(source);
  }
  return warnings;
}
