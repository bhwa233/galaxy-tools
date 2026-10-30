import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
async function fixture(
  options: {
    holdFactory?: boolean;
    holdActivation?: boolean;
    pluginId?: string;
    commands?: Array<Record<string, unknown>>;
    modes?: Array<Record<string, unknown>>;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-source-commands-"));
  const pluginId = options.pluginId ?? "fixture.source",
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
      host: ">=1.3.0 <2",
      platforms: [process.platform],
      architectures: [process.arch],
      entry: "index.html",
      // One inert page satisfies the real commands' window references. This
      // fixture exercises manager/controller authority, not a business renderer.
      ui: {
        theme: "^1.0.0",
        windows: Object.fromEntries(
          (options.commands ?? []).flatMap((command) =>
            typeof command.window === "string" ? [[command.window, { entry: "index.html" }]] : [],
          ),
        ),
      },
      commands: options.commands ?? [
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
      modes: options.modes ?? [{ id: "word-mode", title: "Word mode" }],
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
    environment: defaultHostEnvironment("1.3.0"),
    createRuntime: async () => {
      factories++;
      factoryStarted.resolve();
      if (options.holdFactory) await factoryGate.promise;
      return {
        async activate(activation): Promise<import("@spark233/sdk").JsonValue> {
          activations.push(structuredClone(activation));
          activationStarted.resolve();
          if (options.holdActivation) {
            await activationGate.promise;
            return { items: [{ id: "old-row", title: "Old reply", commandId: "common" }] };
          }
          return { ok: true };
        },
        async query(activation): Promise<import("@spark233/sdk").JsonValue> {
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
    packageFile,
    directory,
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
  it("offers dictionary lookup with the typed text without querying the provider", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve("../../packages/official/translation/package.json"), "utf8"),
    );
    const f = await fixture({
      pluginId: "spark233.translation",
      commands: manifest.spark233.commands.filter((command: { id: string }) =>
        ["workspace", "lookup", "search", "translate"].includes(command.id),
      ),
      modes: manifest.spark233.modes,
    });
    f.setContext({ kind: "text", text: "old selection" });
    const page = await f.controller.query({ query: "hello", sessionId: "lookup" }, caller);
    const item = page.items.find((candidate) => candidate.commandId === "lookup");
    expect(item).toBeDefined();
    expect(page.groups?.some((group) => group.pluginId === "spark233.translation")).toBe(false);
    expect(f.queries).toEqual([]);
    await f.controller.execute(
      { id: item!.id, pluginId: item!.pluginId, commandId: "lookup" },
      caller,
    );
    expect(f.activations.at(-1)).toMatchObject({ context: { kind: "text", text: "hello" } });
    const empty = await f.controller.query({ query: "", sessionId: "empty-lookup" }, caller);
    const emptyItem = empty.items.find((candidate) => candidate.commandId === "lookup");
    expect(emptyItem).toBeDefined();
    await f.controller.execute(
      { id: emptyItem!.id, pluginId: emptyItem!.pluginId, commandId: "lookup" },
      caller,
    );
    expect(f.activations.at(-1)?.context).toBeUndefined();
  });

  it("hands the launcher query to file search instead of a previous selection", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve("../../packages/official/search/package.json"), "utf8"),
    );
    const f = await fixture({
      pluginId: "spark233.search",
      commands: manifest.spark233.commands.filter((command: { id: string }) =>
        ["workspace", "open-search", "search", "content"].includes(command.id),
      ),
      modes: manifest.spark233.modes,
    });
    f.setContext({ kind: "text", text: "old selection" });
    const page = await f.controller.query({ query: "report", sessionId: "search" }, caller);
    const item = page.items.find((candidate) => candidate.commandId === "open-search");
    expect(item).toBeDefined();
    expect(page.items.some((candidate) => candidate.commandId === "search")).toBe(false);
    await f.controller.execute(
      { id: item!.id, pluginId: item!.pluginId, commandId: "open-search" },
      caller,
    );
    expect(f.activations.at(-1)).toMatchObject({ context: { kind: "text", text: "report" } });

    const empty = await f.controller.query({ query: "", sessionId: "empty" }, caller);
    const emptyItem = empty.items.find((candidate) => candidate.commandId === "open-search");
    expect(emptyItem).toBeDefined();
    await f.controller.execute(
      { id: emptyItem!.id, pluginId: emptyItem!.pluginId, commandId: "open-search" },
      caller,
    );
    expect(f.activations.at(-1)?.context).toBeUndefined();
  });

  it("returns local matches immediately and starts only the latest debounced provider", async () => {
    const f = await fixture({
      commands: [
        { id: "common", title: "lookup local", keywords: ["lookup"] },
        { id: "lookup", title: "Provider", search: "default" },
        { id: "word", title: "Word result" },
      ],
      modes: [],
    });
    f.setContext(undefined);
    const first = await f.controller.query({ query: "lookup", sessionId: "first" }, caller);
    expect(first.items.some((item) => item.commandId === "common")).toBe(true);
    const latest = await f.controller.query({ query: "lookup local", sessionId: "latest" }, caller);
    expect(latest.items.some((item) => item.commandId === "common")).toBe(true);
    expect(f.queries).toHaveLength(0);
    await vi.waitFor(() => expect(f.queries).toHaveLength(1));
    expect((f.queries[0].parameters as { query: string }).query).toBe("lookup local");
    f.controller.clear(caller);
  });
  it("offers AI translation for ordinary sentence input and forwards the full text only on execution", async () => {
    // The managed-command filter previously admitted contextInput but dropped
    // textInput, so pasting or injecting a selection hid the Translate action.
    const f = await fixture({
      pluginId: "spark233.translation",
      commands: [
        { id: "other", title: "Other text action", inputs: ["text"], match: "text" },
        {
          id: "translate",
          title: "AI 翻译",
          inputs: ["text"],
          match: "text",
          launcher: { role: "hidden", withInput: true, preferSentence: true },
        },
      ],
      modes: [],
    });
    f.setContext(undefined);
    const text = "This is a complete sentence to translate.\n第二段原文也需要完整传递。";
    const page = await f.controller.query({ query: text, sessionId: "sentence" }, caller);
    expect(page.items[0]?.commandId).toBe("translate");
    expect(f.activations).toEqual([]);
    const item = page.items[0];
    await f.controller.execute(
      { id: item.id, pluginId: item.pluginId, commandId: "translate" },
      caller,
    );
    expect(f.activations.at(-1)?.context).toEqual({ kind: "text", text });
    const word = await f.controller.query({ query: "hello", sessionId: "word" }, caller);
    expect(word.items.some((value) => value.commandId === "translate")).toBe(true);
  });

  it("revalidates a cached launcher candidate before dispatch and detects manifest changes", async () => {
    const f = await fixture();
    const page = await f.controller.query({ query: "", sessionId: "cached" }, caller);
    const item = page.items.find((value) => value.commandId === "common")!;
    const entry = path.join(f.directory, "index.html");
    fs.unlinkSync(entry);
    await expect(
      f.controller.execute({ id: item.id, pluginId, commandId: "common" }, caller),
    ).rejects.toThrow();
    expect(f.activations).toEqual([]);
    fs.writeFileSync(entry, "<p>Restored fixture</p>");
    fs.appendFileSync(f.packageFile, " ");
    expect(f.controller.state(caller).commands.some((value) => value.pluginId === pluginId)).toBe(
      false,
    );
  });
  it("limits the default official entries without removing searchable modes, pins or public commands", async () => {
    const notes = await fixture({
      pluginId: "spark233.notes",
      commands: [
        { id: "open", title: "Manage notes", launcher: { role: "entry" } },
        { id: "new", title: "New note", launcher: { role: "action" } },
        {
          id: "search",
          title: "Search notes",
          mode: "notes",
          search: "mode",
          launcher: { role: "keyword-only" },
        },
      ],
      modes: [{ id: "notes", title: "Notes" }],
    });
    notes.setContext(undefined);
    let page = await notes.controller.query({ query: "", sessionId: "home" }, caller);
    expect(page.items.map((item) => item.commandId)).toEqual(["open", "new"]);
    page = await notes.controller.query({ query: "Search notes", sessionId: "search" }, caller);
    const search = page.items.find((item) => item.commandId === "search");
    expect(search).toBeDefined();
    notes.controller.updatePreference({ selectionId: search!.id, operation: "pin" }, caller);
    page = await notes.controller.query({ query: "", sessionId: "pinned" }, caller);
    expect(page.items.some((item) => item.commandId === "search")).toBe(true);
    expect(() =>
      notes.controller.enterMode({ mode: "spark233.notes:notes" }, caller),
    ).not.toThrow();

    const clipboard = await fixture({
      pluginId: "spark233.clipboard",
      commands: [
        { id: "history", title: "Clipboard history", launcher: { role: "entry" } },
        { id: "quick", title: "Quick clipboard", launcher: { role: "hidden" } },
        { id: "pause", title: "Pause recording", launcher: { role: "hidden" } },
      ],
      modes: [],
    });
    clipboard.setContext(undefined);
    page = await clipboard.controller.query({ query: "", sessionId: "clipboard" }, caller);
    expect(page.items.map((item) => item.commandId)).toEqual(["history"]);
    page = await clipboard.controller.query(
      { query: "Pause recording", sessionId: "managed" },
      caller,
    );
    expect(page.items.some((item) => item.commandId === "pause")).toBe(false);
    expect(clipboard.manager.commands().some(({ command }) => command.id === "pause")).toBe(true);
    await expect(
      clipboard.manager.activate("spark233.clipboard", { commandId: "pause" }),
    ).resolves.toEqual({ ok: true });
  });
  it("keeps legacy dictionary mode requests within the provider limit", async () => {
    // Opening the mode used to send 60 even before typing; the dictionary
    // rejects anything above 30 before handling its empty-query hint.
    const dictionary = await fixture({
      pluginId: "spark233.translation",
      commands: [
        { id: "search", title: "Local dictionary", mode: "dictionary", search: "word" },
        { id: "word", title: "Dictionary detail" },
        { id: "excel", title: "Other dictionary action" },
      ],
      modes: [{ id: "dictionary", title: "Local dictionary" }],
    });
    dictionary.setContext(undefined);
    for (const query of ["", "hello"]) {
      await dictionary.controller.query(
        { query, mode: "spark233.translation:dictionary", sessionId: "dictionary-" + query },
        caller,
      );
      const parameters = dictionary.queries.at(-1)?.parameters as { query: string; limit: number };
      expect(parameters.query).toBe(query);
      expect(parameters.limit).toBeGreaterThanOrEqual(1);
      expect(parameters.limit).toBeLessThanOrEqual(5);
    }
  });

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
