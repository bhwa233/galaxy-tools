import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { UToolsStore } from "./utools-store.js";
import { stageDevelopmentPluginPackage } from "./package-installer.js";
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
