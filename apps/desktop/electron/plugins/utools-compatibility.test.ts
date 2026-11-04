import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { UToolsStore } from "./utools-store.js";
import { stageDevelopmentPluginPackage, stageLocalPluginPackage } from "./package-installer.js";
import { createPackage, getRawHeader, uncache } from "@electron/asar";
import { gzipSync } from "node:zlib";
import { createCipheriv } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { upxsProfile } from "./utools-upxs-profile.js";
import { defaultHostEnvironment } from "./manifest.js";
import { PluginManager } from "./manager.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-utools-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function packageFixture() {
  const root = temporary(),
    source = path.join(root, "source"),
    archive = path.join(root, "fixture.asar");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "plugin.json"),
    JSON.stringify({
      name: "fixture-package",
      pluginName: "Fixture package",
      version: "1.0.0",
      main: "index.html",
      preload: "preload.js",
      features: [{ code: "open", cmds: ["Fixture"] }],
    }),
  );
  fs.writeFileSync(path.join(source, "index.html"), "<p>original content</p>");
  fs.writeFileSync(
    path.join(source, "preload.js"),
    "throw new Error('import must not execute code')",
  );
  await createPackage(source, archive);
  return {
    root,
    archive,
    bytes: fs.readFileSync(archive),
    paths: (suffix: string) => ({
      stagingRoot: path.join(root, suffix, "staging"),
      versionsRoot: path.join(root, suffix, "versions"),
      cacheRoot: path.join(root, suffix, "cache"),
    }),
  };
}

it("imports both uTools containers without execution and rejects modified authenticated metadata", async () => {
  const f = await packageFixture();
  const compressed = gzipSync(f.bytes);
  const encrypt = (kind: "header" | "check", bytes: Uint8Array) => {
    const p = upxsProfile[kind];
    return Buffer.from(
      xchacha20poly1305(Buffer.from(p.key, "hex"), Buffer.from(p.nonce, "hex")).encrypt(bytes),
    );
  };
  const metadata = {
    pluginId: "fixture-package",
    timestamp: 1,
    key: "01".repeat(32),
    iv: "02".repeat(16),
    encrypt2: encrypt("check", Buffer.from("fixture-package1")).toString("hex"),
  };
  const header = encrypt("header", Buffer.from(JSON.stringify(metadata))),
    length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  const cipher = createCipheriv(
    "aes-256-cbc",
    Buffer.from(metadata.key, "hex"),
    Buffer.from(metadata.iv, "hex"),
  );
  const encrypted = Buffer.concat([length, header, cipher.update(compressed), cipher.final()]);
  for (const [extension, bytes] of [
    ["upx", compressed],
    ["upxs", encrypted],
  ] as const) {
    const file = path.join(f.root, "fixture." + extension);
    fs.writeFileSync(file, bytes);
    const staged = await stageLocalPluginPackage(
      file,
      defaultHostEnvironment("0.0.1"),
      f.paths(extension),
    );
    expect(staged.metadata.spark233.compatibility?.kind).toBe("utools");
    expect(fs.readFileSync(path.join(staged.directory, "payload", "index.html"), "utf8")).toBe(
      "<p>original content</p>",
    );
  }
  encrypted[12] = encrypted[12]! ^ 1;
  const bad = path.join(f.root, "modified.upxs");
  fs.writeFileSync(bad, encrypted);
  await expect(
    stageLocalPluginPackage(bad, defaultHostEnvironment("0.0.1"), f.paths("bad")),
  ).rejects.toThrow("认证");
});

it("rejects hostile ASAR paths, external files and expansion limits before publishing a version", async () => {
  const f = await packageFixture();
  const raw = getRawHeader(f.archive);
  uncache(f.archive);
  const payload = f.bytes.subarray(8 + raw.headerSize);
  const variants = [
    { "../escaped.txt": { size: 1, offset: "0" } },
    { external: { link: "../escaped.txt" } },
    { external: { size: 1, offset: "0", unpacked: true } },
    { A: { size: 0, offset: "0" }, a: { size: 0, offset: "0" } },
  ];
  for (const [index, extra] of variants.entries()) {
    const json = Buffer.from(JSON.stringify({ files: { ...raw.header.files, ...extra } }));
    const padded = Math.ceil(json.length / 4) * 4,
      header = Buffer.alloc(16 + padded);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(8 + padded, 4);
    header.writeUInt32LE(4 + padded, 8);
    header.writeUInt32LE(json.length, 12);
    json.copy(header, 16);
    const file = path.join(f.root, "hostile-" + index + ".upx");
    fs.writeFileSync(file, gzipSync(Buffer.concat([header, payload])));
    await expect(
      stageLocalPluginPackage(file, defaultHostEnvironment("0.0.1"), f.paths("hostile-" + index)),
    ).rejects.toThrow();
  }
  expect(fs.existsSync(path.join(f.root, "escaped.txt"))).toBe(false);
  const file = path.join(f.root, "over-budget.upx");
  fs.writeFileSync(file, gzipSync(f.bytes));
  await expect(
    stageLocalPluginPackage(file, defaultHostEnvironment("0.0.1"), f.paths("budget"), {
      limits: { maxExpandedBytes: 8 },
    }),
  ).rejects.toThrow("超限");
});

it("preserves acknowledged data and attachments across reopen while rejecting stale document revisions", () => {
  const dir = temporary();
  let store = new UToolsStore(dir);
  try {
    const first = store.put({ _id: "scene/one", value: "original" });
    expect(first.ok).toBe(true);
    expect(store.put({ _id: "scene/one", value: "lost update" })).toMatchObject({
      error: true,
      name: "conflict",
    });
    expect(store.get("scene/one")?.value).toBe("original");
    const doc = store.get("scene/one")!;
    expect(() => store.put({ ...doc, value: "x".repeat(1024 * 1024) })).toThrow("doc max size 1M");
    expect(store.get("scene/one")?.value).toBe("original");
    store.put({ ...doc, value: "saved" });
    store.storage("setItem", "settings", { theme: "dark" });
    expect(store.get("settings")?.value).toEqual({ theme: "dark" });
    expect(store.storage("getItem", "scene/one")).toBe("saved");
    store.attachment("postAttachment", "image", Buffer.from("persistent bytes"), "image/png");
    store.close();
    store = new UToolsStore(dir);
    expect(store.allDocs("scene/")).toMatchObject([{ _id: "scene/one", value: "saved" }]);
    expect(store.storage("getItem", "settings")).toEqual({ theme: "dark" });
    expect(store.attachment("getAttachment", "image")).toEqual(Buffer.from("persistent bytes"));
    expect(store.allDocs("image")).toMatchObject([{ _id: "image" }]);
    expect(store.remove(doc)).toMatchObject({ error: true, name: "conflict" });
    expect(store.get("scene/one")?.value).toBe("saved");
  } finally {
    store.close();
  }
});

it("imports an immutable uTools snapshot without executing preload and requires native trust before runtime creation", async () => {
  const root = temporary(),
    source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "plugin.json"),
    JSON.stringify({
      name: "fixture.utools",
      main: "index.html",
      preload: "preload.js",
      features: [{ code: "open", cmds: ["Fixture"] }],
    }),
  );
  fs.writeFileSync(path.join(source, "index.html"), "<!doctype html><html></html>");
  fs.writeFileSync(
    path.join(source, "preload.js"),
    "throw new Error('must not run during preview');",
  );
  const packages = {
    stagingRoot: path.join(root, "staging"),
    versionsRoot: path.join(root, "versions"),
    cacheRoot: path.join(root, "cache"),
  };
  const environment = defaultHostEnvironment("0.0.1");
  const staged = await stageDevelopmentPluginPackage(source, environment, packages);
  expect(staged.metadata.spark233.compatibility?.kind).toBe("utools");
  fs.writeFileSync(path.join(source, "preload.js"), "changed after preview");
  expect(fs.readFileSync(path.join(staged.directory, "payload/preload.js"), "utf8")).toContain(
    "must not run",
  );
  let created = 0;
  const manager = new PluginManager({
    stateFile: path.join(root, "state.json"),
    dataRoot: path.join(root, "data"),
    backupRoot: path.join(root, "backups"),
    packages,
    environment,
    createRuntime: async () => {
      created++;
      return { activate: async () => undefined };
    },
  });
  await manager.initialize();
  await expect(
    manager.install(staged, { capabilities: staged.metadata.spark233.capabilities, native: false }),
  ).rejects.toThrow("显式信任");
  expect(created).toBe(0);
  const bad = path.join(root, "bad");
  fs.mkdirSync(bad);
  fs.writeFileSync(
    path.join(bad, "plugin.json"),
    JSON.stringify({
      name: "escape",
      main: "../source/index.html",
      features: [{ code: "open", cmds: ["x"] }],
    }),
  );
  await expect(stageDevelopmentPluginPackage(bad, environment, packages)).rejects.toThrow();
});
