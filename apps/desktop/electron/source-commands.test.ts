import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginActivation, PluginContext } from "@spark233/sdk";
import type { LauncherQueryResult } from "../src/features/launcher/types.js";
import { LauncherController } from "./launcher.js";
import { PluginManager } from "./plugins/manager.js";
import { defaultHostEnvironment } from "./plugins/manifest.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Reuse the real Manager and Controller with owned package files. Only the final
// runtime is synthetic: these tests exercise routing/authority, not Electron UI.
async function fixture(options: { holdFactory?: boolean; holdActivation?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-source-commands-"));
  const pluginId = "fixture.source",
    version = "1.0.0";
  const versionsRoot = path.join(root, "versions"),
    directory = path.join(versionsRoot, pluginId, version);
  fs.mkdirSync(directory, { recursive: true });
  const metadata = {
    name: "@fixture/source",
    version,
    spark233: {
      schemaVersion: 1,
      id: pluginId,
      displayName: "Owned source actions",
      api: "^1.2.0",
      host: "^1.2.0",
      platforms: [process.platform],
      architectures: [process.arch],
      entry: "index.html",
      commands: [
        { id: "common", title: "Common" },
        { id: "legacy", title: "Legacy", inputs: ["text"] },
        {
          id: "word",
          title: "Word action",
          inputs: ["window"],
          match: "window",
          sourceApplications: [" WINWORD.EXE ", "winword.exe"],
        },
        {
          id: "excel",
          title: "Excel action",
          inputs: ["window"],
          sourceApplications: ["excel.exe"],
        },
        {
          id: "lookup",
          title: "Word lookup",
          search: "default",
          sourceApplications: ["winword.exe"],
        },
        {
          id: "mode",
          title: "Word mode",
          mode: "word-mode",
          search: "mode",
          sourceApplications: ["winword.exe"],
        },
      ],
      modes: [{ id: "word-mode", title: "Word mode" }],
    },
  };
  const packageFile = path.join(directory, "package.json"),
    stateFile = path.join(root, "state.json");
  fs.writeFileSync(packageFile, JSON.stringify(metadata));
  fs.writeFileSync(
    path.join(directory, "index.html"),
    "<p>Owned fixture; no renderer launched.</p>",
  );
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          pluginId,
          packageName: metadata.name,
          version,
          directory,
          enabled: true,
          integrity: "owned-fixture",
          manifestDigest: createHash("sha256").update(fs.readFileSync(packageFile)).digest("hex"),
          source: { kind: "directory", location: directory },
          grant: { capabilities: [], native: false },
        },
      },
    }),
  );
  const activations: PluginActivation[] = [],
    queries: PluginActivation[] = [];
  const factoryGate = Promise.withResolvers<void>(),
    activationGate = Promise.withResolvers<void>();
  const factoryStarted = Promise.withResolvers<void>(),
    activationStarted = Promise.withResolvers<void>();
  let factories = 0;
  const manager = new PluginManager({
    stateFile,
    dataRoot: path.join(root, "data"),
    backupRoot: path.join(root, "backup"),
    packages: {
      versionsRoot,
      stagingRoot: path.join(root, "staging"),
      cacheRoot: path.join(root, "cache"),
    },
    environment: defaultHostEnvironment("1.2.0"),
    createRuntime: async () => {
      factories++;
      factoryStarted.resolve();
      if (options.holdFactory) await factoryGate.promise;
      return {
        async activate(activation) {
          activations.push(structuredClone(activation));
          activationStarted.resolve();
          if (options.holdActivation) {
            await activationGate.promise;
            return { items: [{ id: "old-row", title: "Old reply", commandId: "common" }] };
          }
          return { ok: true };
        },
        async query(activation) {
          queries.push(structuredClone(activation));
          return {
            items: [
              {
                id: "word-row",
                title: "Word row",
                commandId: "word",
                actions: [
                  { title: "Wrong source", commandId: "excel" },
                  { title: "Common", commandId: "common" },
                ],
              },
              { id: "excel-row", title: "Excel row", commandId: "excel" },
            ],
          };
        },
      };
    },
  });
  cleanups.push(async () => {
    factoryGate.resolve();
    activationGate.resolve();
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let context: PluginContext | undefined = { kind: "window", sourceApplication: "winword.exe" },
    revision = 1;
  const updates: LauncherQueryResult[] = [];
  const controller = new LauncherController({
    stateFile: path.join(root, "launcher.json"),
    manager: () => manager,
    getContext: () => (context ? { context, label: "Owned context" } : undefined),
    getContextRevision: () => revision,
    onQueryUpdate: (_caller, value) => updates.push(value),
  });
  await manager.initialize();
  return {
    manager,
    controller,
    activations,
    queries,
    updates,
    factoryStarted: factoryStarted.promise,
    activationStarted: activationStarted.promise,
    releaseFactory: factoryGate.resolve,
    releaseActivation: activationGate.resolve,
    get factories() {
      return factories;
    },
    setContext(next: PluginContext | undefined) {
      context = next;
      revision++;
    },
    recapture() {
      revision++;
    },
  };
}

const caller = "owned-caller",
  pluginId = "fixture.source";
describe("source application command authority", () => {
  it("gates discovery, aliases, pins, modes and provider actions using the current host source", async () => {
    const f = await fixture();
    await expect(f.manager.activate(pluginId, { commandId: "word" })).rejects.toThrow();
    await expect(f.manager.query(pluginId, { commandId: "lookup" })).rejects.toThrow();
    expect(f.factories).toBe(0);
    let page = await f.controller.query({ query: "", sessionId: "word" }, caller);
    expect(page.items.some((x) => x.commandId === "common")).toBe(true);
    expect(page.items.some((x) => x.commandId === "excel")).toBe(false);
    const word = page.items.find((x) => x.commandId === "word")!;
    f.controller.updatePreference({ selectionId: word.id, operation: "pin" }, caller);
    page = await f.controller.query({ query: "", sessionId: "pinned-for-alias" }, caller);
    f.controller.updatePreference(
      {
        selectionId: page.items.find((x) => x.commandId === "word")!.id,
        operation: "aliases",
        aliases: ["paper"],
      },
      caller,
    );
    page = await f.controller.query({ query: "paper", sessionId: "alias" }, caller);
    expect(page.items.some((x) => x.commandId === "word")).toBe(true);
    page = await f.controller.query({ query: "", sessionId: "pin" }, caller);
    expect(
      page.groups?.find((x) => x.id === "pinned")?.items.some((x) => x.commandId === "word"),
    ).toBe(true);
    f.controller.enterMode({ mode: "fixture.source:word-mode" }, caller);
    page = await f.controller.query(
      { query: "", sessionId: "mode", mode: "fixture.source:word-mode" },
      caller,
    );
    expect(page.items.map((x) => x.commandId)).toEqual(["word"]);
    expect(page.items[0].actions?.map((x) => x.commandId)).toEqual(["common"]);
    await f.controller.query({ query: "lookup", sessionId: "default-provider" }, caller);
    await expect
      .poll(() =>
        f.updates.some((x) =>
          x.groups?.some((g) => g.pluginId === pluginId && g.status === "ready"),
        ),
      )
      .toBe(true);
    expect(f.updates.at(-1)?.items.some((x) => x.commandId === "excel")).toBe(false);
    f.setContext({ kind: "window", sourceApplication: "excel.exe" });
    await expect(
      f.controller.execute({ id: word.id, pluginId, commandId: "word" }, caller),
    ).rejects.toThrow();
    await expect(f.controller.execute({ pluginId, commandId: "word" }, caller)).rejects.toThrow();
    expect(() => f.controller.enterMode({ mode: "fixture.source:word-mode" }, caller)).toThrow();
    page = await f.controller.query({ query: "paper", sessionId: "other-source" }, caller);
    expect(page.items.some((x) => x.commandId === "word")).toBe(false);
    f.setContext(undefined);
    expect(f.controller.state(caller).commands.some((x) => x.id === "word")).toBe(false);
  });

  it("dispatches only window metadata to window actions and preserves legacy context shapes", async () => {
    const f = await fixture();
    f.setContext({ kind: "text", text: "Private selected body", sourceApplication: "winword.exe" });
    const page = await f.controller.query({ query: "", sessionId: "text" }, caller);
    const word = page.items.find((x) => x.commandId === "word")!;
    await f.controller.execute({ id: word.id, pluginId, commandId: "word" }, caller);
    expect(f.activations.at(-1)?.context).toEqual({
      kind: "window",
      sourceApplication: "winword.exe",
    });
    // Regression: final Manager dispatch must also project content when a host
    // activation reaches it without passing through Controller.providerContext.
    await f.manager.activate(pluginId, {
      commandId: "word",
      context: { kind: "text", text: "Do not forward", sourceApplication: "WINWORD.EXE" },
    });
    expect(f.activations.at(-1)?.context).toEqual({
      kind: "window",
      sourceApplication: "winword.exe",
    });
    await f.manager.activate(pluginId, {
      commandId: "legacy",
      context: { kind: "text", text: "Old shape", sourceApplication: "winword.exe" },
    });
    expect(f.activations.at(-1)?.context).toEqual({ kind: "text", text: "Old shape" });
    await f.manager.activate(pluginId, {
      commandId: "common",
      context: { kind: "window", sourceApplication: "winword.exe" },
    });
    expect(f.activations.at(-1)).not.toHaveProperty("context");
  });

  it("rejects an old action after same-exe recapture while its cold factory is pending", async () => {
    const f = await fixture({ holdFactory: true });
    const page = await f.controller.query({ query: "", sessionId: "capture-a" }, caller);
    const word = page.items.find((x) => x.commandId === "word")!;
    const pending = f.controller.execute({ id: word.id, pluginId, commandId: "word" }, caller);
    const rejected = expect(pending).rejects.toThrow("来源程序已变化");
    await f.factoryStarted;
    f.recapture();
    f.releaseFactory();
    await rejected;
    expect(f.activations).toEqual([]);
  });

  it("lets an accepted activation finish but suppresses its old items after same-exe recapture", async () => {
    const f = await fixture({ holdActivation: true });
    const page = await f.controller.query({ query: "", sessionId: "accepted-a" }, caller);
    const word = page.items.find((x) => x.commandId === "word")!;
    const pending = f.controller.execute({ id: word.id, pluginId, commandId: "word" }, caller);
    await f.activationStarted;
    f.recapture();
    f.releaseActivation();
    await expect(pending).resolves.toBeUndefined();
    expect(f.activations.map((x) => x.commandId)).toEqual(["word"]);
  });
});
