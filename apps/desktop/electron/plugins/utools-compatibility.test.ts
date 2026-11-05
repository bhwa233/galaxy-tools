import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadUToolsNativeId, UToolsStore } from "./utools-store.js";
import {
  stageDevelopmentPluginPackage,
  stageLocalPluginPackage,
  stageUToolsPluginPackage,
} from "./package-installer.js";
import { createPackage, getRawHeader, uncache } from "@electron/asar";
import { gzipSync } from "node:zlib";
import { createCipheriv } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { upxsProfile } from "./utools-upxs-profile.js";
import { defaultHostEnvironment } from "./manifest.js";
import { PluginManager } from "./manager.js";
import {
  createUToolsCallbackQueue,
  loadUToolsPreload,
  projectUToolsList,
} from "./utools-preload-runtime.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-utools-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

it("keeps a device document namespace stable and never replaces a damaged identity", () => {
  const root = temporary();
  const file = path.join(root, "host-a", "native-id");
  const first = loadUToolsNativeId(file);
  expect(loadUToolsNativeId(file)).toBe(first);
  expect(loadUToolsNativeId(path.join(root, "host-b", "native-id"))).not.toBe(first);
  fs.writeFileSync(file, "damaged");
  expect(() => loadUToolsNativeId(file)).toThrow("不能自动更换已有数据身份");
  expect(fs.readFileSync(file, "utf8")).toBe("damaged");
});

it("bounds large legacy lists while preserving the original selection records", () => {
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    title: "结果" + index,
    originalId: index,
  }));
  const large = projectUToolsList(rows);
  expect(large.truncated).toBe(true);
  expect(large.list.length).toBeGreaterThan(0);
  expect(large.list.length).toBeLessThan(rows.length);
  expect(large.rows[0]).toBe(rows[0]);
  const filtered = projectUToolsList([rows[1199]]);
  expect(filtered.truncated).toBe(false);
  expect(filtered.rows[Number(filtered.list[0]!.id)]).toBe(rows[1199]);
  expect(() => projectUToolsList({})).toThrow("格式");
});

it("provides module-relative CommonJS bindings privately to trusted preload code", () => {
  const root = temporary();
  const filename = path.join(root, "preload.js");
  fs.writeFileSync(path.join(root, "dependency.cjs"), "module.exports = '相对依赖';");
  fs.writeFileSync(
    filename,
    "module.exports = { encoded: Buffer.from('银河').toString('base64'), " +
      "dependency: require('./dependency.cjs'), filename: module.filename, " +
      "sameThis: this === exports, marker: process.compatibilityMarker, " +
      "privateGlobal: global.compatibilityMarker };",
  );
  const processBinding = Object.assign(Object.create(process), { compatibilityMarker: "process" });
  const globalBinding = Object.assign(Object.create(globalThis), { compatibilityMarker: "global" });
  expect(
    loadUToolsPreload(filename, { process: processBinding, Buffer, global: globalBinding }),
  ).toEqual({
    encoded: "6ZO25rKz",
    dependency: "相对依赖",
    filename,
    sameThis: true,
    marker: "process",
    privateGlobal: "global",
  });
  expect(Object.hasOwn(process, "compatibilityMarker")).toBe(false);
  expect(Object.hasOwn(globalThis, "compatibilityMarker")).toBe(false);
});

it("waits for asynchronous out state before enter and keeps callback errors observable", async () => {
  const queue = createUToolsCallbackQueue();
  let completeSave!: () => void;
  const saving = new Promise<void>((resolve) => {
    completeSave = resolve;
  });
  let saved = "",
    active = "file A";
  const out = queue("out", async () => {
    await saving;
    saved = active;
    active = "";
  });
  const enter = queue("enter", () => {
    active = "file B";
  });
  await Promise.resolve();
  expect(active).toBe("file A");
  completeSave();
  await Promise.all([out, enter]);
  expect(saved).toBe("file A");
  expect(active).toBe("file B");
  await expect(
    queue("out", () => {
      throw new Error("save failed");
    }),
  ).rejects.toThrow("save failed");
  await queue("enter", () => {
    active = "retry";
  });
  expect(active).toBe("retry");
});

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

it("imports both UPXS layouts without execution and rejects invalid metadata or store identity", async () => {
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
  const legacy = { key: metadata.key, iv: metadata.iv, timestamp: metadata.timestamp };
  const wrap = (fields: Record<string, unknown>) => {
    const header = encrypt("header", Buffer.from(JSON.stringify(fields))),
      length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    const cipher = createCipheriv(
      "aes-256-cbc",
      Buffer.from(metadata.key, "hex"),
      Buffer.from(metadata.iv, "hex"),
    );
    return Buffer.concat([length, header, cipher.update(compressed), cipher.final()]);
  };
  const encrypted = wrap(metadata);
  // Seven real store packages have only key/iv/timestamp. Requiring the
  // extended identity fields rejected them before any payload was inspected.
  for (const [extension, bytes] of [
    ["upx", compressed],
    ["upxs", encrypted],
    ["legacy.upxs", wrap(legacy)],
    [
      "export.upxs",
      wrap({
        ...legacy,
        os: { platform: "win32" },
        app: { version: "6.0.0" },
        developer: { name: "Fixture" },
      }),
    ],
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
  for (const [name, fields] of [
    ["partial-identity", { ...metadata, pluginId: undefined }],
    ["server-decrypt", { ...legacy, serverDecrypt: true }],
    ["unknown-layout", { ...legacy, futureFormat: 2 }],
    ["invalid-export-info", { ...legacy, os: "win32" }],
    [
      "manifest-mismatch",
      {
        ...metadata,
        pluginId: "different-package",
        encrypt2: encrypt("check", Buffer.from("different-package1")).toString("hex"),
      },
    ],
  ] as const) {
    const file = path.join(f.root, name + ".upxs");
    fs.writeFileSync(file, wrap(fields));
    await expect(
      stageLocalPluginPackage(file, defaultHostEnvironment("0.0.1"), f.paths(name)),
    ).rejects.toThrow();
  }
  for (const [catalogId, version] of [
    ["different-package", "1.0.0"],
    ["fixture-package", "2.0.0"],
  ] as const) {
    const paths = f.paths(catalogId + version);
    await expect(
      stageUToolsPluginPackage(
        {
          catalogId,
          version,
          displayName: "Fixture",
          pageURL: "https://www.u-tools.cn/plugins/detail/Fixture/",
          downloadURL: "https://res.u-tools.cn/plugins/fixture.upxs",
        },
        defaultHostEnvironment("0.0.1"),
        paths,
        { fetch: async () => new Response(new Uint8Array(wrap(legacy))) },
      ),
    ).rejects.toThrow("目录身份或版本不一致");
    expect(fs.readdirSync(paths.versionsRoot)).toEqual([]);
  }
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
