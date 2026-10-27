import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { dialog } from "electron";
import { pluginManifestSchema, type ResourceHandle } from "@spark233/sdk";
import { createCapabilityBroker } from "./capabilities.js";
import { PluginResourceScope } from "./resources.js";
import type { PluginManager } from "./manager.js";
vi.mock("electron", () => ({
  clipboard: {},
  dialog: { showOpenDialog: vi.fn() },
  globalShortcut: {},
  Notification: {},
}));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

test("expired or retargeted context references cannot become durable picker permissions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-context-grant-"));
  directories.push(directory);
  const first = path.join(directory, "selected.txt"),
    second = path.join(directory, "different.txt");
  fs.writeFileSync(first, "owned context fixture");
  fs.writeFileSync(second, "different private fixture");
  const owner = { pluginId: "fixture.context", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const manifest = pluginManifestSchema.parse({
    schemaVersion: 1,
    id: owner.pluginId,
    displayName: "Context fixture",
    api: "^1.0.0",
    host: "^1.2.0",
    platforms: [process.platform],
    architectures: [process.arch],
    entry: "index.html",
    capabilities: ["files.read"],
    commands: [{ id: "open", title: "Open" }],
  });
  const resource: ResourceHandle = { id: randomUUID(), kind: "file" };
  const references = new Map([[resource.id, first]]);
  const broker = createCapabilityBroker({
    scope,
    manifest,
    manager: () => ({}) as PluginManager,
    resolveResource: (handle) => references.get(handle.id),
  });
  const read = (id: string) =>
    broker({
      owner,
      capability: "files.read",
      operation: "readText",
      payload: { id },
      signal: new AbortController().signal,
    });
  try {
    broker.grantContext({ kind: "files", resources: [resource] });
    await expect(read(resource.id)).resolves.toBe("owned context fixture");
    references.delete(resource.id); // Even if an explicit revocation notification is missed.
    await expect(read(resource.id)).rejects.toThrow();
    references.set(resource.id, first);
    broker.grantContext({ kind: "files", resources: [resource] });
    references.set(resource.id, second);
    await expect(read(resource.id)).rejects.toThrow();
    references.set(resource.id, first);
    broker.grantContext({ kind: "files", resources: [resource] });
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [first] });
    const picked = (await broker({
      owner,
      capability: "files.read",
      operation: "pick",
      signal: new AbortController().signal,
    })) as { id: string }[];
    broker.revokeContext([resource.id, picked[0].id]);
    await expect(read(resource.id)).rejects.toThrow();
    await expect(read(picked[0].id)).resolves.toBe("owned context fixture");
    expect(fs.readFileSync(second, "utf8")).toBe("different private fixture");
  } finally {
    await scope.stop("quit");
  }
  await expect(read(resource.id)).rejects.toThrow();
});

test("raw native capability payloads cannot manufacture a source application", async () => {
  const owner = { pluginId: "fixture.native-source", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const manifest = pluginManifestSchema.parse({
    schemaVersion: 1,
    id: owner.pluginId,
    displayName: "Native source fixture",
    api: "^1.2.0",
    host: "^1.2.0",
    platforms: [process.platform],
    architectures: [process.arch],
    entry: "index.html",
    capabilities: ["native.process"],
    native: { tool: { path: "tool.exe" } },
    commands: [
      { id: "bound", title: "Bound", sourceApplications: ["notepad.exe"] },
      { id: "ordinary", title: "Ordinary" },
    ],
  });
  const invokeNative = vi.fn(async () => ({ ok: true }));
  const broker = createCapabilityBroker({
    scope,
    manifest,
    manager: () => ({}) as PluginManager,
    invokeNative,
  });
  const invoke = (commandId: string) =>
    broker({
      owner,
      capability: "native.process",
      operation: "invoke",
      payload: { entryId: "tool", commandId, parameters: { sourceApplication: "notepad.exe" } },
      signal: new AbortController().signal,
    });
  try {
    await expect(invoke("bound")).rejects.toThrow();
    expect(invokeNative).not.toHaveBeenCalled();
    await expect(invoke("ordinary")).resolves.toEqual({ ok: true });
    expect(invokeNative).toHaveBeenCalledOnce();
  } finally {
    await scope.stop("quit");
  }
});
