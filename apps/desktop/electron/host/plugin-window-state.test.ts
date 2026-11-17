import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PluginWindowStateStore, PluginWindowLayoutStore } from "./plugin-window-state.js";
import { PluginWindowCoordinator } from "./plugin-window-coordinator.js";
import { pluginWindowCatalog } from "./plugin-window-catalog.js";
import { pluginManifestSchema } from "@spark233/sdk";
import { migratePluginWindowLayout } from "./plugin-window-migration.js";
import { LayerLayoutStore } from "../layer-layout-store.js";
import { PluginUninstallReceipts } from "./plugin-uninstall-receipts.js";
import { runWindowTask, windowOpenContext } from "./plugin-window-routing.js";

// Closing while restore is suspended used to let its late callback show the
// window again. Tasks must also survive closing just one shared placement.
it("invalidates a suspended restore and cancels page work only after the last placement closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-race-"));
  const loaded = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  try {
    const store = new PluginWindowLayoutStore(path.join(root, "layout.json"));
    const manifest = pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "fixture.race",
      displayName: "Race",
      api: "^1.8.0",
      host: ">=0.1.7",
      platforms: ["win32"],
      architectures: ["x64"],
      ui: { theme: "^1.0.0", windows: { main: { entry: "index.html", cardDesktop: true } } },
    });
    const definition = pluginWindowCatalog(manifest)[0];
    let paused = false;
    let shown = 0;
    const coordinator = new PluginWindowCoordinator({
      store,
      definition: () => definition,
      adapter: () => ({
        restore: async () => {
          if (paused) {
            entered.resolve();
            await loaded.promise;
          }
          windowOpenContext.getStore()?.assertActive?.();
          shown++;
        },
        prepareClose: async () => ({ ok: true }),
        closePlacement: async () => {},
      }),
    });
    const request = { pluginId: manifest.id, windowId: "main", action: "open" as const };
    const desktop = await coordinator.open({ ...request, environment: "desktop" });
    const card = await coordinator.open({ ...request, environment: "card-desktop" });
    let signal: AbortSignal | undefined;
    const pending = runWindowTask(desktop.instanceId, () => {
      signal = windowOpenContext.getStore()?.signal;
      return new Promise<void>(() => {});
    });
    const cancelled = expect(pending).rejects.toThrow(/cancelled/);
    await coordinator.close(card.id);
    expect(signal?.aborted).toBe(false);
    paused = true;
    const restoring = coordinator.open({ ...request, environment: "desktop" });
    const refused = expect(restoring).rejects.toThrow(/已关闭/);
    await entered.promise;
    await coordinator.close(desktop.id);
    await cancelled;
    loaded.resolve();
    await refused;
    expect(shown).toBe(2);
    expect(store.load().placements).toEqual([]);
    paused = false;
    await coordinator.open({ ...request, environment: "desktop" });
    expect(shown).toBe(3);
  } finally {
    loaded.resolve();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("serializes singleton opens and closes placements without waiting for save permission", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-layout-"));
  try {
    const store = new PluginWindowLayoutStore(path.join(root, "layout.json"));
    const manifest = pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "fixture.windows",
      displayName: "Windows",
      api: "^1.8.0",
      host: ">=0.1.7",
      platforms: ["win32"],
      architectures: ["x64"],
      ui: { theme: "^1.0.0", windows: { main: { entry: "index.html", cardDesktop: true } } },
    });
    const definition = pluginWindowCatalog(manifest)[0];
    const prepareClose = vi.fn(async () => ({ ok: false }));
    const coordinator = new PluginWindowCoordinator({
      store,
      definition: () => definition,
      adapter: () => ({
        restore: async () => {},
        prepareClose,
        closePlacement: async () => {},
      }),
    });
    const request = { pluginId: manifest.id, windowId: "main", action: "open" as const };
    const [first, second] = await Promise.all([
      coordinator.open({ ...request, environment: "card-desktop" }),
      coordinator.open({ ...request, environment: "card-desktop" }),
    ]);
    expect(first.id).toBe(second.id);
    await expect(
      coordinator.open({
        ...request,
        environment: "card-desktop",
        binding: { windowId: "other", parameterVersion: 1 },
      }),
    ).rejects.toThrow(/不属于/);
    await coordinator.open({ ...request, environment: "desktop" });
    const cleanup = coordinator.beginCleanup(manifest.id);
    expect(store.load().placements).toHaveLength(2);
    coordinator.cancelCleanup(cleanup);
    await coordinator.close(first.id);
    expect(prepareClose).not.toHaveBeenCalled();
    expect(
      new PluginWindowLayoutStore(path.join(root, "layout.json")).load().placements,
    ).toHaveLength(1);
    expect(store.load().instances).toHaveLength(1);
    expect(store.load().placements.map((placement) => placement.environment)).toEqual(["desktop"]);
    const uninstall = coordinator.beginCleanup(manifest.id);
    // Simulate a committed uninstall with a lost response, then a newer owner.
    const receiptsFile = path.join(root, "uninstall-receipts.json");
    const receipts = new PluginUninstallReceipts(receiptsFile);
    receipts.record(store.load().cleanup.find((intent) => intent.id === uninstall)!);
    const newer = { ...store.load().instances[0], id: randomUUID() };
    store.commit((draft) => {
      draft.instances.push(newer);
      draft.placements.push({ ...draft.placements[0], id: randomUUID(), instanceId: newer.id });
    });
    const restarted = new PluginWindowLayoutStore(path.join(root, "layout.json"));
    const recovery = new PluginWindowCoordinator({
      store: restarted,
      definition: () => definition,
      adapter: () => {
        throw new Error("Recovery must not open or save a window");
      },
    });
    const retained = recovery.beginCleanup("fixture.retained");
    const unknown = recovery.beginCleanup("fixture.unknown");
    const recoveredReceipts = new PluginUninstallReceipts(receiptsFile);
    expect(recoveredReceipts.outcome({ id: uninstall, pluginId: "fixture.unknown" })).toBe(
      "unknown",
    );
    await recovery.reconcileCleanup(async (intent) =>
      intent.id === retained ? "retained" : recoveredReceipts.outcome(intent),
    );
    expect(restarted.load().instances.map((value) => value.id)).toEqual([newer.id]);
    expect(restarted.load().placements.map((value) => value.instanceId)).toEqual([newer.id]);
    expect(
      new PluginWindowLayoutStore(path.join(root, "layout.json"))
        .load()
        .cleanup.map((value) => value.id),
    ).toEqual([unknown]);
    recoveredReceipts.retain(new Set(restarted.load().cleanup.map((intent) => intent.id)));
    expect(
      new PluginUninstallReceipts(receiptsFile).outcome({ id: uninstall, pluginId: manifest.id }),
    ).toBe("unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("retains an unknown creation result across restart instead of creating replacement content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-intent-"));
  try {
    const file = path.join(root, "layout.json");
    const store = new PluginWindowLayoutStore(file);
    const definition = pluginWindowCatalog(
      pluginManifestSchema.parse({
        schemaVersion: 1,
        id: "fixture.notes",
        displayName: "Notes",
        api: "^1.8.0",
        host: ">=0.1.7",
        platforms: ["win32"],
        architectures: ["x64"],
        backend: { entry: "backend.js" },
        capabilities: ["node.backend"],
        commands: [{ id: "create", title: "Create", internal: true }],
        ui: {
          theme: "^1.0.0",
          windows: {
            note: {
              entry: "index.html",
              cardDesktop: true,
              reuse: "document",
              create: { commandId: "create" },
            },
          },
        },
      }),
    )[0];
    let creates = 0;
    const coordinator = new PluginWindowCoordinator({
      store,
      definition: () => definition,
      adapter: () => ({
        create: async () => {
          creates++;
          throw new Error("Response lost");
        },
        restore: async () => {},
        prepareClose: async () => ({ ok: true }),
        closePlacement: async () => {},
      }),
    });
    const creationId = randomUUID();
    await expect(
      coordinator.open({
        pluginId: definition.pluginId,
        windowId: "note",
        environment: "card-desktop",
        action: "create",
        creationId,
      }),
    ).rejects.toThrow("Response lost");
    expect(new PluginWindowLayoutStore(file).load().pendingCreates).toHaveLength(1);
    await expect(
      coordinator.open({
        pluginId: definition.pluginId,
        windowId: "note",
        environment: "card-desktop",
        action: "create",
        creationId,
      }),
    ).rejects.toMatchObject({ code: "window.creationUnconfirmed" });
    await expect(
      coordinator.resumeCreates(store.load().pendingCreates[0].id),
    ).rejects.toMatchObject({ code: "window.creationUnconfirmed" });
    await expect(
      coordinator.open({
        pluginId: definition.pluginId,
        windowId: "note",
        environment: "card-desktop",
        action: "restore",
      }),
    ).rejects.toThrow(/不能通过恢复创建/);
    expect(creates).toBe(1);
    // Two recovery callers can capture the same durable intent before either
    // acquires the queue. A maintenance fence must also stop a queued replay.
    let blocked = true;
    let unavailable = false;
    store.commit((draft) => {
      draft.pendingCreates[0].pluginId = "spark233.notes";
    });
    let finishCreate!: (binding: {
      windowId: string;
      contentId: string;
      parameterVersion: number;
    }) => void;
    let signalCreate!: () => void;
    const started = new Promise<void>((resolve) => {
      signalCreate = resolve;
    });
    const recovered = new PluginWindowCoordinator({
      store,
      blocked: () => blocked,
      unavailable: () => unavailable,
      definition: () => ({ ...definition, pluginId: "spark233.notes" }),
      adapter: () => ({
        create: async () => {
          creates++;
          signalCreate();
          return new Promise((resolve) => {
            finishCreate = resolve;
          });
        },
        restore: async () => {},
        prepareClose: async () => ({ ok: true }),
        closePlacement: async () => {},
      }),
    });
    await recovered.resumeCreates();
    expect(creates).toBe(1);
    blocked = false;
    const replay = recovered.resumeCreates();
    await started;
    const duplicate = recovered.resumeCreates();
    unavailable = true;
    finishCreate({ windowId: "note", contentId: "original-note", parameterVersion: 1 });
    await Promise.all([replay, duplicate]);
    expect(store.load().instances).toHaveLength(0);
    expect(store.load().pendingCreates).toHaveLength(1);
    unavailable = false;
    const retry = recovered.resumeCreates();
    const concurrent = recovered.resumeCreates();
    await Promise.resolve();
    await Promise.resolve();
    finishCreate({ windowId: "note", contentId: "original-note", parameterVersion: 1 });
    await Promise.all([retry, concurrent]);
    expect(store.load().instances.map((value) => value.binding.contentId)).toEqual([
      "original-note",
    ]);
    expect(store.load().placements).toHaveLength(1);
    expect(store.load().pendingCreates).toHaveLength(0);
    expect(creates).toBe(3);
    // Manual recovery is scoped to the selected intent and restores its binding.
    const binding = { windowId: "note", contentId: "selected-note", parameterVersion: 1 };
    const selectedId = randomUUID(),
      unrelatedId = randomUUID();
    store.commit((draft) => {
      const intent = {
        pluginId: "fixture.notes",
        windowId: "note",
        environment: "card-desktop" as const,
        bounds: { x: 24, y: 110, width: 500, height: 400 },
        binding,
      };
      draft.pendingCreates.push(
        { ...intent, id: selectedId },
        { ...intent, id: unrelatedId, binding: { ...binding, contentId: "unrelated-note" } },
      );
    });
    await coordinator.resumeCreates(selectedId);
    expect(store.load().pendingCreates.map((value) => value.id)).toEqual([unrelatedId]);
    expect(store.load().instances.map((value) => value.binding.contentId)).toEqual([
      "original-note",
      "selected-note",
    ]);
    expect(creates).toBe(3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("restores each plugin profile independently without using the notes database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-state-"));
  try {
    const file = path.join(root, "windows.json");
    const store = new PluginWindowStateStore(file);
    const first = {
      pluginId: "fixture.first",
      profile: "main",
      bounds: { x: 12, y: 34, width: 800, height: 600 },
      topmost: false,
    };
    const second = {
      pluginId: "fixture.second",
      profile: "main",
      bounds: { x: 56, y: 78, width: 640, height: 420 },
      topmost: true,
    };
    store.remember(first);
    store.remember(second);
    store.flush();
    first.bounds.width = 999;
    const restored = new PluginWindowStateStore(file);
    expect(restored.get("fixture.first", "main")?.bounds.width).toBe(800);
    expect(restored.get("fixture.second", "main")).toEqual(second);
    expect(restored.get("fixture.first", "quick")).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reuses a durable add-panel intent after presentation fails and the host restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-add-retry-"));
  try {
    const file = path.join(root, "layout.json");
    const definition = pluginWindowCatalog(
      pluginManifestSchema.parse({
        schemaVersion: 1,
        id: "fixture.document",
        displayName: "Document",
        api: "^1.8.0",
        host: ">=0.1.7",
        platforms: ["win32"],
        architectures: ["x64"],
        backend: { entry: "backend.js" },
        capabilities: ["node.backend"],
        commands: [{ id: "create", title: "Create", internal: true }],
        ui: {
          theme: "^1.0.0",
          windows: {
            main: {
              entry: "index.html",
              cardDesktop: true,
              reuse: "document",
              create: { commandId: "create" },
            },
          },
        },
      }),
    )[0];
    let creates = 0;
    let failPresentation = true;
    const adapter = () => ({
      create: async () => {
        creates++;
        return { windowId: "main", contentId: "saved-document", parameterVersion: 1 };
      },
      restore: async () => {
        if (failPresentation) throw new Error("Presentation failed");
      },
      prepareClose: async () => ({ ok: true }),
      closePlacement: async () => {},
    });
    const request = {
      pluginId: definition.pluginId,
      windowId: "main",
      environment: "card-desktop" as const,
      action: "create" as const,
      creationId: randomUUID(),
    };
    const first = new PluginWindowCoordinator({
      store: new PluginWindowLayoutStore(file),
      definition: () => definition,
      adapter,
    });
    await expect(first.open(request)).rejects.toThrow("Presentation failed");
    failPresentation = false;
    const store = new PluginWindowLayoutStore(file);
    const restarted = new PluginWindowCoordinator({ store, definition: () => definition, adapter });
    const [retry, duplicate] = await Promise.all([
      restarted.open(request),
      restarted.open(request),
    ]);
    expect(retry.id).toBe(duplicate.id);
    expect(store.load().instances.map((instance) => instance.id)).toEqual([request.creationId]);
    expect(store.load().pendingCreates).toEqual([]);
    expect(creates).toBe(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves unreadable geometry instead of replacing it with a partial new snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-damage-"));
  try {
    const file = path.join(root, "windows.json");
    fs.writeFileSync(file, "{ damaged");
    const store = new PluginWindowStateStore(file);
    expect(store.readError).toBeDefined();
    store.remember({
      pluginId: "fixture.first",
      profile: "main",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      topmost: false,
    });
    store.flush();
    expect(fs.readFileSync(file, "utf8")).toBe("{ damaged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("recovers interrupted migration without promoting ordinary windows or deleting changed legacy sources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-migration-"));
  try {
    const layer = new LayerLayoutStore({ file: path.join(root, "desktop.json") });
    const store = new PluginWindowLayoutStore(path.join(root, "windows.json"));
    const manifest = pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "fixture.migrate",
      displayName: "Fixture",
      api: "^1.8.0",
      host: ">=0.1.7",
      platforms: ["win32"],
      architectures: ["x64"],
      ui: {
        theme: "^1.0.0",
        windows: {
          main: { entry: "index.html", cardDesktop: true },
          ordinary: { entry: "index.html", cardDesktop: true },
        },
      },
    });
    const definitions = pluginWindowCatalog(manifest);
    const source = layer.load();
    const instanceId = "37ffba87-3e8b-4651-9ff3-11af6f059666";
    const ordinaryId = randomUUID();
    const mainId = "window:" + instanceId;
    const ordinaryCardId = "window:" + ordinaryId;
    const area = { x: -1920, y: 0, width: 1920, height: 1080 };
    source.cards[mainId] = {
      kind: "window",
      pluginId: manifest.id,
      windowProfile: "main",
      windowInstanceId: instanceId,
      bounds: { x: -1800, y: 150, width: 500, height: 400 },
      displayId: "left",
      workAreaAtSave: area,
      group: "top",
      inputMode: "interactive",
      visible: true,
      restore: true,
      createdAt: 0,
      order: 1,
    };
    source.cards[ordinaryCardId] = {
      ...source.cards[mainId],
      windowProfile: "ordinary",
      windowInstanceId: ordinaryId,
      order: 2,
    };
    await layer.commit({ ...source, revision: source.revision + 1 }, source.revision);
    fs.writeFileSync(
      path.join(root, "desktop-overlay-layout.json"),
      JSON.stringify({
        panels: {
          [mainId]: {
            selected: true,
            positions: { left: { x: -1760, y: 170, width: 500, height: 400 } },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, "plugin-windows.json"),
      JSON.stringify([
        {
          pluginId: manifest.id,
          profile: "main",
          topmost: false,
          bounds: { x: 50, y: 50, width: 800, height: 600 },
        },
      ]),
    );
    const options = {
      store,
      layer,
      hostRoot: root,
      configRoot: root,
      definition: (_pluginId: string, windowId: string) =>
        definitions.find((definition) => definition.windowId === windowId),
      displayId: "right",
      area: { ...area, x: 0 },
    };
    const interrupted = vi
      .spyOn(layer, "commit")
      .mockRejectedValueOnce(new Error("Retirement interrupted"));
    await expect(migratePluginWindowLayout(options)).rejects.toThrow("Retirement interrupted");
    interrupted.mockRestore();
    const migrated = store.load();
    expect(migrated.placements.map((value) => value.environment)).toEqual([
      "desktop",
      "card-desktop",
      "desktop",
    ]);
    expect(migrated.placements[0].topmost).toBe(true);
    expect(migrated.placements[0].visible).toBe(true);
    expect(migrated.placements[0].bounds.x).toBe(-1800);
    expect(migrated.instances[0].autoRestore).toBe(true);
    expect(migrated.placements[1].bounds).toEqual({ x: 160, y: 170, width: 500, height: 400 });
    expect(Object.keys(layer.load().cards)).toEqual([mainId, ordinaryCardId]);
    const changedSource = layer.load();
    changedSource.cards[ordinaryCardId].bounds.x = -1600;
    await layer.commit(
      { ...changedSource, revision: changedSource.revision + 1 },
      changedSource.revision,
    );
    await migratePluginWindowLayout(options);
    const recovered = store.load();
    expect(recovered.instances).toEqual(migrated.instances);
    expect(recovered.placements).toEqual(migrated.placements);
    expect(Object.keys(layer.load().cards)).toEqual([ordinaryCardId]);
    expect(recovered.migration?.warnings).toContain(
      ordinaryCardId + ": changed legacy source retained after interrupted migration",
    );
    await migratePluginWindowLayout(options);
    expect(store.load()).toEqual(recovered);
    expect(fs.readdirSync(root).some((file) => file.startsWith("window-migration-"))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
