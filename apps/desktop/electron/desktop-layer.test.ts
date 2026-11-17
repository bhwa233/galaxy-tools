import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import type { LayerCard, LayerClientRequest, LayerEvent } from "../shared/layer-contract.js";
import { DesktopLayer, type DesktopLayerOptions } from "./desktop-layer.js";
import { LayerWindow } from "./layer-window.js";
import { LayerLayoutStore } from "./layer-layout-store.js";
import { UToolsDesktopHost } from "./plugins/utools-desktop.js";
import { PluginResourceScope } from "./plugins/resources.js";
import type { PluginPackageMetadata } from "@spark233/sdk";
import type { UToolsDesktopPresentation } from "../shared/utools-desktop.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

async function fixture(options: Partial<DesktopLayerOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-overlay-"));
  const area = { x: -1600, y: -100, width: 1600, height: 1000 };
  const cards: LayerCard[] = [
    {
      id: "note",
      renderKind: "notes",
      renderRef: "n",
      displayId: "left",
      group: "normal",
      inputMode: "interactive",
      visible: true,
      order: 1,
      bounds: { x: -1200, y: 30, width: 170, height: 32 },
    },
    {
      id: "image",
      renderKind: "screenshot",
      displayId: "left",
      group: "top",
      inputMode: "passive",
      visible: true,
      order: 2,
      bounds: { x: -700, y: 300, width: 320, height: 180 },
    },
  ];
  let ack = true,
    cursor = { x: -1000, y: 200 };
  const restored = vi.fn();
  const natives: BrowserWindow[] = [];
  const events: LayerEvent[] = [];
  const seq = new Map<string, number>();
  const store = new LayerLayoutStore({ file: path.join(directory, "layout.json") });
  const invoke = (id: string, request: LayerClientRequest) => {
    const snapshot = layer.snapshot(id);
    const native = layer
      .windows()
      .find((w) => w === layer.windowForCard(snapshot.cards[0]?.id ?? ""))!;
    const sender = native.webContents;
    const next = (seq.get(id) ?? 0) + 1;
    seq.set(id, next);
    return layer.handle({ sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent, {
      ...request,
      protocol: 1,
      surfaceId: id,
      surfaceGeneration: snapshot.surfaceGeneration,
      seq: next,
    });
  };
  const layer = new DesktopLayer({
    store,
    displays: () => [{ id: "left", workArea: area, scaleFactor: 1.5 }],
    primaryDisplay: () => "left",
    cursor: () => cursor,
    theme: () => "light",
    locale: () => "zh-CN",
    flags: () => ({ enabled: true, notesEnabled: true, webEnabled: true }),
    diagnostic: vi.fn(),
    onOverlayClosed: restored,
    ...options,
    createWindow: (spec) => {
      let visible = false,
        destroyed = false,
        bounds = { ...spec.bounds };
      const webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "fixture:" + spec.id },
        setWindowOpenHandler: vi.fn(),
        isDevToolsOpened: () => false,
        send: (_channel: string, event: LayerEvent) => {
          events.push(event);
          if (ack && event.type === "snapshot" && event.snapshot.presentationRevision !== undefined)
            queueMicrotask(
              () =>
                void invoke(spec.id, {
                  type: "presentation-committed",
                  revision: event.snapshot.presentationRevision!,
                }),
            );
        },
      });
      const native = Object.assign(new EventEmitter(), {
        webContents,
        setMenu: vi.fn(),
        setIgnoreMouseEvents: vi.fn(),
        setFocusable: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        setShape: vi.fn(),
        moveAbove: vi.fn(),
        moveTop: vi.fn(),
        focus: vi.fn(),
        isFocused: () => false,
        getMediaSourceId: () => spec.id,
        loadURL: async () => {},
        getBounds: () => ({ ...bounds }),
        setBounds: (next: typeof bounds) => {
          bounds = { ...next };
        },
        isVisible: () => visible,
        isDestroyed: () => destroyed,
        showInactive: () => {
          visible = true;
        },
        hide: () => {
          visible = false;
        },
        destroy: vi.fn(() => {
          visible = false;
          destroyed = true;
          native.emit("closed");
        }),
      }) as unknown as BrowserWindow;
      natives.push(native);
      const window = new LayerWindow({
        ...spec,
        mode: "shared",
        entryURL: webContents.mainFrame.url,
        title: "fixture",
        label: spec.id,
        preloadPath: "",
        screen: { getDisplayMatching: vi.fn() },
        timers: { setTimeout, clearTimeout },
        createBrowserWindow: () => native,
        diagnostic: spec.fault,
        onClosed: spec.closed,
      });
      return { window, entryURL: webContents.mainFrame.url };
    },
  });
  layer.register({ id: "fixture", snapshot: () => cards });
  await Promise.resolve();
  for (const card of cards) await invoke(layer.surfaceForCard(card.id)!, { type: "ready" });
  cleanups.push(async () => {
    ack = true;
    await layer.closeOverlay(false);
    await layer.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    layer,
    cards,
    natives,
    store,
    restored,
    events,
    invoke,
    ack: (value: boolean) => {
      ack = value;
    },
    cursor: (p: typeof cursor) => {
      cursor = p;
    },
  };
}

it("reuses source windows, moves only bar geometry and restores native presentation after layout commit", async () => {
  const f = await fixture();
  const desktop = f.natives.map((w) => w.getBounds());
  const original = structuredClone(f.cards);
  const revision = f.store.load().revision;
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.layer.openOverlay();
    expect(f.layer.windows()).toEqual(f.natives);
    const id = f.layer.surfaceForCard("image")!;
    const snapshot = f.layer.snapshot(id),
      card = snapshot.cards[0]!;
    const epoch = snapshot.overlay!.epoch!;
    expect(f.layer.isOverlayWindow(f.natives[1]!)).toBe(true);
    await f.invoke(id, {
      type: "overlay-layout",
      overlayEpoch: epoch,
      cardId: card.id,
      bounds: { ...card.bounds, x: -500, y: 400 },
    });
    expect(f.layer.card(card.id)!.bounds).toEqual(original[1]!.bounds);
    await f.layer.closeOverlay(true);
    expect(f.natives.map((w) => w.getBounds())).toEqual(desktop);
    expect(f.natives[0]!.setAlwaysOnTop).toHaveBeenLastCalledWith(false, "pop-up-menu");
    expect(f.natives[1]!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(f.natives[1]!.setFocusable).toHaveBeenLastCalledWith(false);
    expect(f.natives.every((w) => !w.isDestroyed() && w.isVisible())).toBe(true);
  }
  expect(f.store.load().revision).toBe(revision);
  expect(f.cards).toEqual(original);
  expect(f.restored).toHaveBeenCalledTimes(3);
});

it("reveals the shade and ready cards together after a slow participant commits", async () => {
  const f = await fixture();
  const card = {
    ...f.cards[1]!,
    id: "slow-window",
    renderKind: "window" as const,
    renderRef: "slow-window",
  };
  f.cards.push(card);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reveal = vi.fn();
  const stop = f.layer.registerExternal(card.id, {
    present: async (value) => {
      if (value.mode === "overlay") {
        entered.resolve();
        await release.promise;
      }
    },
    reveal,
  });
  try {
    const opening = f.layer.openOverlay();
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.natives.every((window) => !window.isVisible())).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
    release.resolve();
    await opening;
    expect(f.natives.every((window) => window.isVisible())).toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    stop();
  }
});

it("projects compatibility-owned windows without creating content surfaces and keeps desktop and bar placement independent", async () => {
  const f = await fixture();
  const host = new UToolsDesktopHost({
    layer: f.layer,
    store: f.store,
    pluginHost: () => undefined,
  });
  const scope = new PluginResourceScope({
    pluginId: "utools.fixture",
    version: "1.0.0",
    instanceId: "first",
  });
  cleanups.unshift(async () => {
    await scope.stop("disable");
  });
  const presentations: Array<UToolsDesktopPresentation | null> = [];
  let refuseUnpin = false;
  const request = host.attach(
    scope,
    { spark233: { displayName: "Fixture editor" } } as PluginPackageMetadata,
    async (value) => {
      if (value === null && refuseUnpin) throw new Error("runner restore failed");
      presentations.push(value);
    },
  );
  const desktop = { x: -1100, y: 100, width: 500, height: 300 };
  await request({ type: "pin", featureCode: "edit", bounds: desktop });
  await expect.poll(() => presentations.at(-1)?.mode).toBe("desktop");
  const instance = host.list()[0]!;
  const id = "utools:" + instance.widgetInstanceId;
  expect(f.layer.windows()).toEqual(f.natives);
  await f.layer.openOverlay();
  const bar = presentations.at(-1)!;
  expect(bar?.mode).toBe("overlay");
  expect(f.layer.snapshot(f.layer.surfaceForCard("note")!).overlay?.panels).toContainEqual(
    expect.objectContaining({ cardId: id, kind: "utools" }),
  );
  const moved = { x: -700, y: 350, width: 600, height: 260 };
  await request({ type: "bounds", revision: bar!.revision, bounds: moved });
  await expect.poll(() => presentations.at(-1)?.card.bounds).toEqual(moved);
  await request({ type: "panel", revision: presentations.at(-1)!.revision, action: "hide" });
  await expect.poll(() => presentations.at(-1)?.visible).toBe(false);
  const stale = presentations.at(-1)!.revision;
  await f.layer.closeOverlay(false);
  await expect.poll(() => presentations.at(-1)?.mode).toBe("desktop");
  expect(presentations.at(-1)?.visible).toBe(true);
  expect(presentations.at(-1)?.card.bounds).toEqual({
    ...desktop,
    width: moved.width,
    height: moved.height,
  });
  await expect(request({ type: "bounds", revision: stale, bounds: moved })).rejects.toThrow(
    "布局已变化",
  );
  await f.layer.openOverlay();
  expect(presentations.at(-1)?.card.bounds).toEqual(moved);
  expect(presentations.at(-1)?.visible).toBe(false);
  // A failed unpin used to delete the durable card and management/retry entry
  // before the compatibility window acknowledged restoration.
  refuseUnpin = true;
  await expect(request({ type: "unpin" })).rejects.toThrow("runner restore failed");
  expect(f.store.load().cards[id]).toBeDefined();
  expect(host.has(instance.widgetInstanceId)).toBe(true);
  expect(host.list()[0]?.status).toBe("fault");
  refuseUnpin = false;
  const failedCommit = vi
    .spyOn(f.store, "removeUTools")
    .mockRejectedValueOnce(new Error("layout write failed"));
  await expect(request({ type: "unpin" })).rejects.toThrow("layout write failed");
  expect(f.store.load().cards[id]).toBeDefined();
  expect(presentations.at(-1)?.mode).toBe("desktop");
  failedCommit.mockRestore();
  await request({ type: "unpin" });
  expect(presentations.at(-1)).toBeNull();
  expect(host.list()).toEqual([]);
  expect(f.store.load().cards[id]).toBeUndefined();
  expect(f.layer.windows()).toEqual(f.natives);
});

it("rejects requests from a replaced compatibility owner and restores the saved desktop identity", async () => {
  const f = await fixture();
  const host = new UToolsDesktopHost({
    layer: f.layer,
    store: f.store,
    pluginHost: () => undefined,
  });
  const metadata = { spark233: { displayName: "Fixture editor" } } as PluginPackageMetadata;
  const first = new PluginResourceScope({
    pluginId: "utools.fixture",
    version: "1.0.0",
    instanceId: "first",
  });
  const old = host.attach(first, metadata, async () => {});
  await old({
    type: "pin",
    featureCode: "edit",
    bounds: { x: -1100, y: 100, width: 500, height: 300 },
  });
  const identity = host.list()[0]!.widgetInstanceId;
  const second = new PluginResourceScope({
    pluginId: "utools.fixture",
    version: "1.0.1",
    instanceId: "second",
  });
  const presentations: UToolsDesktopPresentation[] = [];
  let failPresentation = false;
  host.attach(second, metadata, async (value) => {
    if (failPresentation) throw new Error("presentation refused");
    if (value) presentations.push(value);
  });
  cleanups.unshift(async () => {
    await first.stop("disable");
    await second.stop("disable");
  });
  await expect.poll(() => presentations.length).toBeGreaterThan(0);
  await expect(old({ type: "unpin" })).rejects.toThrow("实例已失效");
  expect(host.list()[0]!.widgetInstanceId).toBe(identity);
  f.layer.setVisibility("locked", true);
  await expect.poll(() => presentations.at(-1)?.visible).toBe(false);
  f.layer.setVisibility("locked", false);
  await expect.poll(() => presentations.at(-1)?.visible).toBe(true);
  failPresentation = true;
  f.layer.setVisibility("locked", true);
  await expect.poll(() => host.list()[0]?.status).toBe("fault");
  failPresentation = false;
  await host.retry(identity);
  await expect.poll(() => host.list()[0]?.status).toBe("active");
  expect(host.list()[0]?.widgetInstanceId).toBe(identity);
});

it("waits for a located window's presentation and cancels focus after the overlay closes", async () => {
  const f = await fixture();
  const card: LayerCard = {
    ...f.cards[1],
    id: "external-window",
    renderKind: "window",
    renderRef: "existing-instance",
    cardDesktopOnly: true,
    cardDesktopMember: true,
  };
  f.cards.push(card);
  const activate = vi.fn();
  let hold = false;
  let release!: () => void;
  let started!: () => void;
  let presenting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stop = f.layer.registerExternal(card.id, {
    present: async (value) => {
      if (hold && value.mode === "overlay" && value.visible) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    activate,
  });
  try {
    await f.layer.openOverlay();
    await f.layer.externalPanel(card.id, "hide");
    hold = true;
    const locating = f.layer.locateWindow("existing-instance");
    await presenting;
    expect(activate).not.toHaveBeenCalled();
    release();
    await locating;
    expect(activate).toHaveBeenCalledOnce();
    await f.layer.externalPanel(card.id, "hide");
    presenting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const obsolete = f.layer.locateWindow("existing-instance");
    await presenting;
    const closing = f.layer.closeOverlay(false);
    release();
    await Promise.all([obsolete, closing]);
    expect(activate).toHaveBeenCalledOnce();
  } finally {
    hold = false;
    release?.();
    stop();
  }
});

it("gives only the current host transient input priority and restores card focus without saving layout", async () => {
  const f = await fixture();
  const card: LayerCard = {
    ...f.cards[1],
    id: "native-card",
    renderKind: "window",
    renderRef: "native-instance",
    cardDesktopMember: true,
  };
  const cachedCard: LayerCard = { ...card, id: "cached-native-card", renderRef: "cached-instance" };
  f.cards.push(cachedCard, card);
  const activateCached = vi.fn();
  // A uTools blur report can arrive after another HWND has already reported
  // focus. Its cached `true` must not replace the most recent native event.
  const stopCached = f.layer.registerExternal(cachedCard.id, {
    focus: () => true,
    activate: activateCached,
    present: async () => {},
  });
  const activate = vi.fn();
  const restack = vi.fn();
  let focused = true;
  let release!: () => void;
  let blocking = false;
  const stop = f.layer.registerExternal(card.id, {
    focus: () => focused,
    activate,
    restack,
    present: async (value) => {
      if (blocking && value.inputBlocked)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  try {
    await f.layer.openOverlay();
    f.layer.noteOverlayFocus(card.id);
    f.layer.restackOverlay();
    const hostId = [
      ...new Set(f.cards.map((value) => f.layer.surfaceForCard(value.id)).filter(Boolean)),
    ].find((id) => f.layer.snapshot(id!).overlay?.host)!;
    const otherId = f.layer.surfaceForCard("image")!;
    const epoch = f.layer.snapshot(hostId).overlay!.epoch!;
    const original = structuredClone(f.cards);
    const revision = f.store.load().revision;
    blocking = true;
    const modalId = "11111111-1111-4111-8111-111111111111";
    await expect(
      f.invoke(otherId, {
        type: "overlay-transient",
        id: modalId,
        kind: "modal",
        open: true,
        overlayEpoch: epoch,
      }),
    ).rejects.toThrow("workspace host");
    let acknowledged = false;
    const opening = f
      .invoke(hostId, {
        type: "overlay-transient",
        id: modalId,
        kind: "modal",
        open: true,
        overlayEpoch: epoch,
      })
      .then(() => {
        acknowledged = true;
      });
    await expect.poll(() => !!release).toBe(true);
    expect(acknowledged).toBe(false);
    expect(f.layer.externalPresentation(card.id)?.inputBlocked).toBe(true);
    expect(f.layer.windowForCard("image")!.setFocusable).toHaveBeenLastCalledWith(false);
    await expect(f.invoke(otherId, { type: "overlay-close", overlayEpoch: epoch })).rejects.toThrow(
      "管理面板",
    );
    await expect(f.layer.externalPanel(card.id, "hide")).rejects.toThrow("管理面板");
    release();
    blocking = false;
    focused = false;
    await opening;
    restack.mockClear();
    f.layer.restackOverlay();
    f.layer.refresh();
    await Promise.resolve();
    expect(restack).not.toHaveBeenCalled();
    const host = f.layer.windowForCard("note")!;
    expect(host.moveTop).toHaveBeenCalled();
    const menuId = "22222222-2222-4222-8222-222222222222";
    await f.invoke(hostId, {
      type: "overlay-transient",
      id: menuId,
      kind: "menu",
      open: true,
      overlayEpoch: epoch,
    });
    await expect(
      f.invoke(hostId, {
        type: "overlay-transient",
        id: modalId,
        kind: "modal",
        open: false,
        overlayEpoch: epoch,
      }),
    ).rejects.toThrow("失效");
    expect(f.layer.snapshot(hostId).overlay?.transient?.id).toBe(menuId);
    await f.invoke(hostId, {
      type: "overlay-transient",
      id: menuId,
      kind: "menu",
      open: false,
      overlayEpoch: epoch,
    });
    expect(f.layer.overlayInputBlocked).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
    expect(activateCached).not.toHaveBeenCalled();
    expect(f.layer.externalPresentation(card.id)?.inputBlocked).toBe(false);
    expect(f.layer.noteOverlayFocus(card.id)).toBe(false);
    expect(f.cards).toEqual(original);
    expect(f.store.load().revision).toBe(revision);
  } finally {
    release?.();
    stop();
    stopCached();
  }
});

it("keeps a failed add modal and reuses the created identity while waiting for native presentation", async () => {
  let complete!: (value: { instanceId: string }) => void;
  const create = vi.fn(
    () =>
      new Promise<{ instanceId: string }>((resolve) => {
        complete = resolve;
      }),
  );
  const f = await fixture({
    overlayLaunchers: () => [
      {
        pluginId: "fixture",
        commandId: "document",
        title: "Document",
        plugin: "Fixture",
        favorite: false,
        windowId: "document",
      },
    ],
    onOverlayLaunch: create,
  });
  await f.layer.openOverlay();
  const hostId = f.layer.surfaceForCard("note")!;
  const epoch = f.layer.snapshot(hostId).overlay!.epoch!;
  const id = "33333333-3333-4333-8333-333333333333";
  await f.invoke(hostId, {
    type: "overlay-transient",
    id,
    kind: "modal",
    open: true,
    overlayEpoch: epoch,
  });
  const request = {
    type: "overlay-launch" as const,
    pluginId: "fixture",
    commandId: "document",
    transientId: id,
    overlayEpoch: epoch,
  };
  const first = f.invoke(hostId, request);
  const duplicate = f.invoke(hostId, request);
  const rejected = Promise.allSettled([first, duplicate]);
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith("fixture", "document", id);
  const card: LayerCard = {
    ...f.cards[1],
    id: "created-card",
    renderKind: "window",
    renderRef: "created-instance",
    cardDesktopMember: true,
  };
  f.cards.push(card);
  let fail = true;
  const activate = vi.fn();
  const stop = f.layer.registerExternal(card.id, {
    present: async (value) => {
      if (fail && value.mode === "overlay") throw new Error("native presentation refused");
    },
    activate,
  });
  try {
    complete({ instanceId: "created-instance" });
    expect((await rejected).every((value) => value.status === "rejected")).toBe(true);
    expect(f.layer.snapshot(hostId).overlay?.transient?.id).toBe(id);
    expect(f.layer.overlayInputBlocked).toBe(true);
    fail = false;
    await expect(f.invoke(hostId, request)).resolves.toEqual({ cardId: card.id });
    expect(create).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    await f.invoke(hostId, {
      type: "overlay-transient",
      id,
      kind: "modal",
      open: false,
      activateCardId: card.id,
      overlayEpoch: epoch,
    });
    expect(activate).toHaveBeenCalledOnce();
    await expect(f.invoke(hostId, request)).rejects.toThrow("失效");
    expect(create).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("rolls back transient input constraints when a native participant rejects opening", async () => {
  const f = await fixture();
  const activate = vi.fn();
  const card: LayerCard = {
    ...f.cards[1],
    id: "rejecting-card",
    renderKind: "window",
    cardDesktopMember: true,
  };
  f.cards.push(card);
  const stop = f.layer.registerExternal(card.id, {
    focus: () => true,
    activate,
    present: async (value) => {
      if (value.inputBlocked) throw new Error("blocked presentation refused");
    },
  });
  try {
    await f.layer.openOverlay();
    const hostId = f.layer.surfaceForCard("note")!;
    await expect(
      f.invoke(hostId, {
        type: "overlay-transient",
        id: "44444444-4444-4444-8444-444444444444",
        kind: "modal",
        open: true,
        overlayEpoch: f.layer.snapshot(hostId).overlay!.epoch,
      }),
    ).rejects.toThrow("blocked presentation refused");
    expect(f.layer.overlayActive).toBe(true);
    expect(f.layer.overlayInputBlocked).toBe(false);
    expect(f.layer.externalPresentation(card.id)?.inputBlocked).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("rejects old sessions and cross-surface authority, and derives native drag from trusted cursor DIPs", async () => {
  const f = await fixture();
  await f.layer.openOverlay();
  const id = f.layer.surfaceForCard("image")!;
  const old = f.layer.snapshot(id).overlay!.epoch!;
  await f.layer.closeOverlay(false);
  await f.layer.openOverlay();
  const snapshot = f.layer.snapshot(id),
    epoch = snapshot.overlay!.epoch!;
  await expect(f.invoke(id, { type: "overlay-close", overlayEpoch: old })).rejects.toThrow("失效");
  await expect(
    f.invoke(id, { type: "overlay-panel", overlayEpoch: epoch, cardId: "note", action: "hide" }),
  ).rejects.toThrow("失效");
  const card = snapshot.cards[0]!,
    header = card.overlayControls!;
  await f.invoke(id, {
    type: "overlay-pointer",
    overlayEpoch: epoch,
    cardId: card.id,
    pointerId: 4,
    phase: "start",
    clientPoint: {
      x: header.x - snapshot.bounds!.x + 10,
      y: header.y - snapshot.bounds!.y + 10,
    },
  });
  f.cursor({ x: header.x + 110, y: header.y + 70 });
  await f.invoke(id, {
    type: "overlay-pointer",
    overlayEpoch: epoch,
    cardId: card.id,
    pointerId: 4,
    phase: "end",
  });
  expect(f.layer.snapshot(id).cards[0]!.bounds).toMatchObject({
    x: card.bounds.x + 100,
    y: card.bounds.y + 60,
  });
  expect(f.layer.card(card.id)!.bounds).toEqual(f.cards[1]!.bounds);
});

it("ignores obsolete layout acknowledgments and rolls back a timed-out open without losing a source", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  f.ack(false);
  const opening = f.layer.openOverlay();
  await Promise.resolve();
  const id = f.layer.surfaceForCard("note")!;
  const pending = f.layer.snapshot(id).presentationRevision!;
  await f.invoke(id, { type: "presentation-committed", revision: pending - 1 });
  expect(f.natives[0]!.isVisible()).toBe(false);
  f.ack(true);
  await vi.advanceTimersByTimeAsync(2500);
  await opening;
  expect(f.layer.overlayActive).toBe(false);
  expect(f.natives.every((w) => !w.isDestroyed() && w.isVisible())).toBe(true);
  expect(f.restored).toHaveBeenLastCalledWith(false);
});
