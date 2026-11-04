import { BrowserWindow, Menu, powerMonitor, screen, shell } from "electron";
import path from "node:path";
import type {
  CapsuleEntry,
  CapsuleItem,
  CapsuleQueue,
  CapsuleSnapshot,
  Rect,
  Edge,
} from "../src/features/capsules/types.js";
import {
  contains,
  edgeDistance,
  intersectRect,
  insertMembers,
  members,
  nearestEdge,
  pillWidth,
  PILL_HEIGHT,
  previewGeometry,
  previewCorridor,
  queueGeometry,
  queueInsertionIndex,
  queueKey,
  SLOT_PITCH,
} from "./capsule-layout.js";
import type { NotesDataClient } from "./plugins/official/notes-data-client.js";
import type { AppConfig } from "../src/features/settings/types.js";
import { AppError } from "./persistence.js";
import { externalUrl } from "./security.js";
import { LayerWindow } from "./layer-window.js";
import type { LayerCard } from "../shared/layer-contract.js";
import type { DesktopLayer } from "./desktop-layer.js";
import { allocateLayerCards, DEFAULT_LAYER_QUOTAS } from "./layer-layout-store.js";
interface Options {
  here: string;
  url: string;
  entries: Map<string, CapsuleEntry>;
  notes: () => Pick<NotesDataClient, "list" | "get">;
  getConfig: () => AppConfig;
  dataRoot: () => string;
  save: () => void | Promise<void>;
  open: (id: string) => void | Promise<void>;
  hide: (id: string) => Promise<void>;
  changed: () => void;
  globalMenu: () => Electron.Menu | Promise<Electron.Menu>;
  onRendererCrash?: (error: Error) => void;
  canInteract?: () => boolean;
}
interface Surface {
  win: BrowserWindow;
  layer?: LayerWindow;
  key: string;
  bounds: Rect;
  snapshot: CapsuleSnapshot;
  ready: boolean;
}
interface Drag {
  owner: number;
  ownerCard?: string;
  id: string;
  queue?: string;
  entries: CapsuleEntry[];
  start: Electron.Point;
  point: Electron.Point;
  origin: Rect;
  offset: number;
  timer: ReturnType<typeof setInterval>;
}
// Existing window/Markdown primitives are reused. DOM drag libraries cannot move OS windows or
// capture across mixed-DPI monitors; this controller only coordinates Electron screen DIPs and HWNDs.
export class Capsules {
  readonly surfaces = new Map<string, Surface>();
  readonly queues = new Map<string, CapsuleQueue>();
  private hover?: { id: string; anchor: Rect; edge: Edge; owner: number; due: number };
  private previewId?: string;
  private previewAnchor?: Rect;
  private previewEdge?: Edge;
  private leaveSince = 0;
  private ticker: ReturnType<typeof setInterval>;
  private drag?: Drag;
  private suppressed: Rect[] = [];
  private hidden = false;
  private enabled = true;
  private systemSuppressed = new Set<"locked" | "suspend">();
  private releaseEnvironment: () => void;
  private titles = new Map<string, string>();
  private refreshGeneration = 0;
  private previewGeneration = 0;
  private desktopLayer?: DesktopLayer;
  private releaseDesktopLayer?: () => void;
  private quotaSignature = "";
  private label(chinese: string, english: string): string {
    return this.options.getConfig().locale.startsWith("en") ? english : chinese;
  }
  private save(): Promise<void> {
    const operation = Promise.resolve().then(() => this.options.save());
    void operation.catch(console.error);
    return operation;
  }
  constructor(private options: Options) {
    this.ticker = setInterval(() => this.tick(), 60);
    this.releaseEnvironment = LayerWindow.observeEnvironment({
      screen,
      powerMonitor,
      timers: { setTimeout, clearTimeout },
      onDisplayChange: this.displayChanged,
      onSuppressed: (reason, value) => {
        if (value) {
          this.systemSuppressed.add(reason);
          this.cancelDrag();
          this.hidePreview();
        } else this.systemSuppressed.delete(reason);
        for (const s of this.surfaces.values()) s.layer?.setSuppressed(reason, value);
        this.desktopLayer?.refresh();
      },
      onRestore: () => {
        if (this.enabled) this.refresh();
      },
    });
  }
  private displayChanged = () => {
    if (!this.enabled) return;
    this.cancelDrag();
    this.hidePreview();
    this.refresh();
    this.save();
  };
  owns(win: BrowserWindow) {
    return [...this.surfaces.values()].some((s) => s.layer?.win === win);
  }
  nativeWindows(): BrowserWindow[] {
    return [...this.surfaces.values()].flatMap((surface) => (surface.layer ? [surface.win] : []));
  }
  /** Focus/capture exclusions may include shared windows; callers must never
   * destroy these as notes-owned resources because widgets can share the HWND. */
  presentationWindows(): BrowserWindow[] {
    const windows = new Set(this.nativeWindows());
    for (const surface of this.surfaces.values()) {
      if (surface.layer || !surface.snapshot.items[0]) continue;
      const win = this.desktopLayer?.windowForCard(this.cardId(surface, surface.snapshot.items[0]));
      if (win && !win.isDestroyed()) windows.add(win);
    }
    return [...windows];
  }
  /** Check a proposed visible note without changing the live layout or closing
   * its editor. The same prediction is used when entering/restoring the layer. */
  assertCanShow(
    entry: CapsuleEntry | readonly CapsuleEntry[],
    queuePatch?: Partial<CapsuleQueue> & { key: string },
  ): void {
    const proposed = Array.isArray(entry)
      ? (entry as readonly CapsuleEntry[])
      : [entry as CapsuleEntry];
    if (this.desktopLayer) this.assertLayerQuota(this.desktopLayer, proposed, queuePatch);
  }
  private assertLayerQuota(
    layer: DesktopLayer,
    proposed: readonly CapsuleEntry[] = [],
    queuePatch?: Partial<CapsuleQueue> & { key: string },
  ): void {
    const replacements = new Map(proposed.map((entry) => [entry.label, entry]));
    const entries = [...this.options.entries.values()].map(
      (entry) => replacements.get(entry.label) ?? entry,
    );
    for (const entry of proposed)
      if (!entries.some((existing) => existing.label === entry.label)) entries.push(entry);
    const displays = screen.getAllDisplays();
    // Follow render()'s display fallback without mutating the live capsule.
    const planned = entries.map((entry) =>
      entry.visible &&
      entry.capsule &&
      !displays.some((display) => String(display.id) === entry.capsule!.displayId)
        ? {
            ...entry,
            capsule: {
              ...entry.capsule,
              displayId: String(screen.getDisplayMatching(entry.bounds).id),
            },
          }
        : entry,
    );
    const views: string[] = [];
    for (const display of displays)
      for (const edge of ["left", "right", "top"] as const) {
        const key = queueKey(String(display.id), edge),
          group = members(planned, key);
        if (!group.length) continue;
        const queue = {
          ...(this.queues.get(key) ?? {
            key,
            offset: edge === "top" ? 0 : 100,
            collapsed: false,
            scroll: 0,
            ...(edge === "top" ? { centered: true } : {}),
          }),
          ...(queuePatch?.key === key ? queuePatch : {}),
        };
        const geometry = queueGeometry(
          display.workArea,
          edge,
          queue,
          group.map((entry) => pillWidth(this.title(entry.noteId!))),
        );
        views.push(String(display.id)); // master is a real shared-layer card too.
        if (!queue.collapsed)
          group.forEach((_, index) => {
            const slot = geometry.slot(index);
            if (
              edge === "top"
                ? !!intersectRect(slot, geometry.viewport)
                : slot.y >= SLOT_PITCH && slot.y + slot.height <= geometry.bounds.height
            ) {
              views.push(String(display.id));
            }
          });
      }
    for (const entry of planned)
      if (entry.visible && entry.folded && entry.noteId && entry.capsule?.kind === "floating")
        views.push(
          String(screen.getDisplayNearestPoint({ x: entry.capsule.x, y: entry.capsule.y }).id),
        );
    const widgets = layer
      .snapshot()
      .cards.filter((card) => card.renderKind !== "notes" && card.visible);
    const counts = new Map<string, number>();
    for (const id of [...views, ...widgets.map((card) => card.displayId)])
      counts.set(id, (counts.get(id) ?? 0) + 1);
    if (
      views.length > DEFAULT_LAYER_QUOTAS.perPlugin ||
      views.length + widgets.length > DEFAULT_LAYER_QUOTAS.total ||
      [...counts.values()].some((count) => count > DEFAULT_LAYER_QUOTAS.perDisplay)
    )
      throw new AppError(
        "layer.quotaExceeded",
        "桌面层活动卡片超过配额，已保留当前便签状态；请先隐藏部分卡片",
      );
  }
  private layerPillBudget(entries: readonly CapsuleEntry[], displays: readonly Electron.Display[]) {
    const masters = displays.reduce(
      (count, display) =>
        count +
        ["left", "right", "top"].filter(
          (edge) => members(entries, queueKey(String(display.id), edge as Edge)).length,
        ).length,
      0,
    );
    const floating = entries.filter(
      (entry) =>
        entry.visible && entry.folded && entry.noteId && entry.capsule?.kind === "floating",
    ).length;
    return Math.max(0, DEFAULT_LAYER_QUOTAS.perPlugin - masters - floating);
  }
  /** Queue/floating views share trusted layer windows. Preview and drag keep the
   * existing globally bounded native windows and the same controller behavior. */
  async setDesktopLayer(layer?: DesktopLayer): Promise<void> {
    if (this.desktopLayer === layer) return;
    if (layer) this.assertLayerQuota(layer);
    this.cancelDrag();
    this.hidePreview();
    this.releaseDesktopLayer?.();
    this.releaseDesktopLayer = undefined;
    for (const surface of this.surfaces.values()) await surface.layer?.destroy();
    this.surfaces.clear();
    this.desktopLayer = layer;
    if (layer)
      this.releaseDesktopLayer = layer.register({
        id: "trusted-notes",
        snapshot: () => this.layerCards(),
        onInvoke: (cardId, command, args, presentation) =>
          this.handleLayer(cardId, command, args, presentation),
        onPointersCancelled: () => this.hidePreview(),
      });
    await this.refresh();
    {
      const deadline = Date.now() + 5000;
      while (
        layer
          ? this.layerCards().some((card) => !layer.isCardReady(card.id))
          : [...this.surfaces.values()].some((surface) => !surface.ready)
      ) {
        if (Date.now() > deadline)
          throw new AppError("capsuleUnavailable", "便签展示窗口未就绪，已保留布局");
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
  }
  private cardId(surface: Surface, item: CapsuleItem): string {
    return "notes-view:" + surface.key + "/" + item.id;
  }
  private layerCards(): LayerCard[] {
    return this.quotaCards().map((card) => ({
      ...card,
      visible: !this.systemSuppressed.size,
    }));
  }
  /** Lock/suspend only suppress presentation; their logical reservations remain
   * until notes are explicitly hidden or disabled. */
  quotaCards(): LayerCard[] {
    if (!this.desktopLayer || !this.enabled || this.hidden) return [];
    const cards = [...this.surfaces.values()]
      .filter((surface) => !surface.layer)
      .flatMap((surface) =>
        surface.snapshot.items.map((item, order) => ({
          id: this.cardId(surface, item),
          consumerId: "trusted-notes",
          displayId: String(screen.getDisplayMatching(surface.bounds).id),
          group: "top" as const,
          inputMode: "interactive" as const,
          bounds: {
            ...item.rect,
            x: surface.bounds.x + item.rect.x,
            y: surface.bounds.y + item.rect.y,
          },
          clip: item.clip,
          order,
          visible: true,
          renderKind: "notes" as const,
          renderRef: item.id,
          payload: {
            ...surface.snapshot,
            items: [{ ...item, rect: { ...item.rect, x: 0, y: 0 } }],
          } as unknown as import("@spark233/sdk").JsonValue,
        })),
      );
    const active = new Set(
      allocateLayerCards(
        cards.map((card) => ({
          id: card.id,
          renderKind: "notes" as const,
          card: {
            ...card,
            kind: "notes" as const,
            noteId: card.renderRef,
            workAreaAtSave: card.bounds,
            restore: true,
            createdAt: card.renderRef.startsWith("master:") ? 0 : 1,
          },
        })),
      ).active,
    );
    return cards.filter((card) => active.has(card.id));
  }
  private publishLayerQuota(): void {
    const signature = JSON.stringify(this.quotaCards().map((card) => [card.id, card.displayId]));
    if (signature === this.quotaSignature) return;
    this.quotaSignature = signature;
    this.options.changed();
  }
  private async handleLayer(
    cardId: string,
    command: string,
    args: Record<string, unknown>,
    presentation?: { bounds: Rect },
  ): Promise<unknown> {
    const surface = [...this.surfaces.values()].find(
      (entry) =>
        !entry.layer && entry.snapshot.items.some((item) => this.cardId(entry, item) === cardId),
    );
    const item = surface?.snapshot.items.find((entry) => this.cardId(surface, entry) === cardId);
    if (
      !surface ||
      !item ||
      this.options.canInteract?.() === false ||
      !this.desktopLayer?.isCardVisible(cardId) ||
      ![
        "capsule_activate",
        "capsule_open",
        "capsule_hover",
        "capsule_hide",
        "capsule_drag_start",
        "capsule_drag_end",
        "capsule_scroll",
        "capsule_menu",
      ].includes(command) ||
      (args.id !== undefined && args.id !== item.id)
    )
      throw new AppError("permissionDenied", "不属于此桌面便签的操作");
    if (command === "capsule_drag_end" && this.drag?.ownerCard !== cardId) return;
    if (command === "capsule_hover" && presentation) {
      // The trusted desktop host supplies the bar's anchor; never accept a
      // renderer-provided screen position or alter the note's real placement.
      return this.handleSurface(
        {
          ...surface,
          bounds: presentation.bounds,
          snapshot: {
            ...surface.snapshot,
            items: [{ ...item, clip: undefined, rect: { ...presentation.bounds, x: 0, y: 0 } }],
          },
        },
        surface.win,
        command,
        args,
        cardId,
      );
    }
    return this.handleSurface(surface, surface.win, command, args, cardId);
  }
  private queue(key: string) {
    let value = this.queues.get(key);
    if (!value) {
      value = {
        key,
        offset: key.endsWith(":top") ? 0 : 100,
        collapsed: false,
        scroll: 0,
        ...(key.endsWith(":top") ? { centered: true } : {}),
      };
      this.queues.set(key, value);
    }
    return value;
  }
  restore(value: unknown) {
    if (!Array.isArray(value)) return;
    for (const q of value)
      if (q && typeof q.key === "string" && Number.isFinite(q.offset))
        this.queues.set(q.key, {
          key: q.key,
          offset: q.offset,
          collapsed: !!q.collapsed,
          scroll: Number.isFinite(q.scroll) ? q.scroll : 0,
          ...(typeof q.centered === "boolean" ? { centered: q.centered } : {}),
        });
  }
  async fold(entry: CapsuleEntry) {
    if (!this.enabled) throw new AppError("pluginDisabled", "便签插件已停用");
    const display = screen.getDisplayMatching(entry.bounds),
      point = {
        x: entry.bounds.x + entry.bounds.width / 2,
        y: entry.bounds.y + entry.bounds.height / 2,
      };
    const placement: NonNullable<CapsuleEntry["capsule"]> = entry.capsule ?? {
      kind: "docked",
      displayId: String(display.id),
      edge: nearestEdge({ id: String(display.id), workArea: display.workArea }, point),
      order: 0,
      x: entry.bounds.x,
      y: entry.bounds.y,
    };
    this.assertCanShow({ ...entry, capsule: placement, folded: true, visible: true });
    const before = {
      folded: entry.folded,
      visible: entry.visible,
      capsule: entry.capsule ? { ...entry.capsule } : undefined,
    };
    try {
      entry.capsule = placement;
      entry.folded = true;
      entry.visible = true;
      if (entry.capsule.kind === "docked") {
        const peers = members(
          this.options.entries.values(),
          queueKey(entry.capsule.displayId, entry.capsule.edge),
        ).filter((e) => e !== entry);
        if (peers.some((e) => e.capsule!.order === entry.capsule!.order))
          entry.capsule.order = Math.max(-1, ...peers.map((e) => e.capsule!.order)) + 1;
      }
      await this.refresh();
      const key =
        entry.capsule.kind === "docked"
          ? `queue:${queueKey(entry.capsule.displayId, entry.capsule.edge)}`
          : `floating:${entry.noteId}`;
      const surface = this.surfaces.get(key);
      for (let i = 0; i < 60; i++) {
        if (!surface || surface.ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!this.enabled || !surface?.ready || surface.win.isDestroyed())
        throw new AppError("capsuleUnavailable", "胶囊窗口未就绪，已保留便签窗口");
      await surface.win.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      if (!this.enabled) throw new AppError("pluginDisabled", "便签插件已停用");
      await this.save();
    } catch (error) {
      Object.assign(entry, before);
      this.refresh();
      throw error;
    }
  }
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const generation = ++this.refreshGeneration;
    // Native geometry never waits for storage. Only presentation summaries are
    // cached, and a retired owner cannot publish a late asynchronous response.
    this.render();
    const operation = Promise.resolve()
      .then(() => this.options.notes().list())
      .then((notes) => {
        if (!this.enabled || generation !== this.refreshGeneration) return;
        this.titles = new Map(
          notes.map((note) => [
            note.id,
            note.title || note.preview.slice(0, 30) || this.label("无标题便签", "Untitled note"),
          ]),
        );
        this.render();
      });
    void operation.catch((error) => {
      if (this.enabled && generation === this.refreshGeneration) console.error(error);
    });
    return operation;
  }
  private render() {
    if (!this.enabled) return;
    const wanted = new Set<string>(),
      entries = [...this.options.entries.values()];
    const displays = screen.getAllDisplays();
    for (const e of entries)
      if (e.visible && e.capsule) {
        if (!displays.some((d) => String(d.id) === e.capsule!.displayId)) {
          const d = screen.getDisplayMatching(e.bounds);
          e.capsule.displayId = String(d.id);
        }
      }
    let budget = this.desktopLayer ? this.layerPillBudget(entries, displays) : undefined;
    for (const display of displays)
      for (const edge of ["left", "right", "top"] as const) {
        const key = queueKey(String(display.id), edge),
          group = members(entries, key);
        if (!group.length) continue;
        const queue = this.queue(key),
          geometry = queueGeometry(
            display.workArea,
            edge,
            queue,
            group.map((e) => pillWidth(this.title(e.noteId!))),
            budget,
          );
        queue.scroll = geometry.scroll;
        const items: CapsuleItem[] = [
          {
            id: `master:${key}`,
            title: "spark233",
            master: true,
            count: group.length,
            collapsed: queue.collapsed,
            rect: geometry.master,
          },
        ];
        if (!queue.collapsed)
          group.forEach((e, i) => {
            if (budget !== undefined && items.length - 1 >= budget) return;
            const rect = geometry.slot(i);
            const visible = edge === "top" ? intersectRect(rect, geometry.viewport) : undefined;
            if (
              edge === "top"
                ? Boolean(visible)
                : rect.y >= SLOT_PITCH && rect.y + rect.height <= geometry.bounds.height
            )
              items.push({
                id: e.noteId!,
                title: this.title(e.noteId!),
                expanded: !e.folded,
                rect,
                ...(visible
                  ? {
                      clip: {
                        x: visible.x - rect.x,
                        y: visible.y - rect.y,
                        width: visible.width,
                        height: visible.height,
                      },
                    }
                  : {}),
              });
          });
        if (budget !== undefined) budget -= items.length - 1;
        const surfaceKey = `queue:${key}`;
        wanted.add(surfaceKey);
        this.surface(surfaceKey, geometry.bounds, { kind: "queue", key, edge, items });
      }
    for (const entry of entries)
      if (entry.visible && entry.folded && entry.capsule?.kind === "floating" && entry.noteId) {
        const d = screen.getDisplayNearestPoint({ x: entry.capsule.x, y: entry.capsule.y }),
          a = d.workArea,
          width = pillWidth(this.title(entry.noteId));
        const bounds = {
          x: Math.round(Math.max(a.x, Math.min(a.x + a.width - width, entry.capsule.x))),
          y: Math.round(Math.max(a.y, Math.min(a.y + a.height - PILL_HEIGHT, entry.capsule.y))),
          width,
          height: PILL_HEIGHT,
        };
        entry.capsule.x = bounds.x;
        entry.capsule.y = bounds.y;
        const key = `floating:${entry.noteId}`;
        wanted.add(key);
        this.surface(key, bounds, {
          kind: "floating",
          items: [
            {
              id: entry.noteId,
              title: this.title(entry.noteId),
              rect: { x: 0, y: 0, width, height: PILL_HEIGHT },
            },
          ],
        });
      }
    for (const [key, s] of this.surfaces)
      if (!["preview", "drag"].includes(key) && !wanted.has(key)) {
        if (!s.layer && this.drag?.ownerCard?.startsWith("notes-view:" + key + "/"))
          this.cancelDrag();
        // The pointer-capture owner stays alive until drop/cancel, even if its queue empties.
        if (s.layer && this.drag?.owner === s.win.id) s.layer.hide();
        else {
          void s.layer?.destroy();
          this.surfaces.delete(key);
        }
      }
    if (
      this.previewId &&
      !entries.some((e) => e.noteId === this.previewId && e.visible && e.folded)
    )
      this.hidePreview();
    this.applyZOrder();
    this.publishLayerQuota();
    this.desktopLayer?.refresh();
  }
  private title(id: string) {
    return this.titles.get(id) ?? "无标题便签";
  }
  private surface(key: string, bounds: Rect, snapshot: CapsuleSnapshot): Surface {
    if (!this.enabled) throw new AppError("pluginDisabled", "便签插件已停用");
    let surface = this.surfaces.get(key);
    if (this.desktopLayer && (snapshot.kind === "queue" || snapshot.kind === "floating")) {
      if (!surface) {
        const getLayer = () => this.desktopLayer;
        surface = {
          key,
          bounds,
          snapshot,
          get win() {
            const first = this.snapshot.items[0];
            const win = first && getLayer()?.windowForCard("notes-view:" + key + "/" + first.id);
            if (!win) throw new AppError("capsuleUnavailable", "桌面便签窗口尚未就绪");
            return win;
          },
          get ready() {
            return (
              !!this.snapshot.items[0] &&
              !!getLayer()?.isCardReady("notes-view:" + key + "/" + this.snapshot.items[0].id)
            );
          },
        };
        this.surfaces.set(key, surface);
      }
      surface.bounds = bounds;
      surface.snapshot = snapshot;
      return surface;
    }
    if (!surface) {
      const layer = new LayerWindow({
        id: key,
        mode:
          snapshot.kind === "preview"
            ? "notes-preview"
            : snapshot.kind === "drag"
              ? "notes-drag"
              : "shared",
        bounds,
        group: "top",
        inputMode: snapshot.kind === "drag" ? "passive" : "interactive",
        fullscreenBehavior: "lower",
        order: snapshot.kind === "drag" ? 2 : snapshot.kind === "preview" ? 1 : 0,
        title: this.label("spark233 胶囊", "spark233 capsules"),
        entryURL: `${this.options.url}?view=capsule`,
        preloadPath: path.join(this.options.here, "preload.cjs"),
        label: `capsule:${key}`,
        screen,
        createBrowserWindow: (options) => new BrowserWindow(options),
        timers: { setTimeout, clearTimeout },
        diagnostic: (code, error) => {
          if (code === "renderer-gone") this.options.onRendererCrash?.(error);
          else console.error(error);
        },
        onClosed: () => {
          if (this.surfaces.get(key)?.layer === layer) this.surfaces.delete(key);
        },
      });
      surface = { win: layer.win, layer, key, bounds, snapshot, ready: false };
      this.surfaces.set(key, surface);
      layer.setFullscreen(this.suppressed);
      layer.setSuppressed("user", this.hidden);
      for (const reason of this.systemSuppressed) layer.setSuppressed(reason, true);
    }
    const displayId = String(surface.layer!.display(bounds).id);
    // Legacy snapshot rects are client-local; LayerCard geometry is screen DIP.
    // Preview/drag retain the entire original hit rectangle, not only their items.
    const items =
      snapshot.kind === "queue"
        ? snapshot.items
        : [
            {
              id: key,
              rect: { x: 0, y: 0, width: bounds.width, height: bounds.height },
            },
          ];
    const cards: LayerCard[] = items.map((item, order) => ({
      id: item.id,
      displayId,
      group: "top",
      inputMode: snapshot.kind === "drag" ? "passive" : "interactive",
      bounds: { ...item.rect, x: bounds.x + item.rect.x, y: bounds.y + item.rect.y },
      clip: "clip" in item ? item.clip : undefined,
      order,
      visible: true,
    }));
    const previous = surface.snapshot;
    surface.snapshot = snapshot;
    surface.bounds = bounds;
    if (!surface.layer!.apply(cards, bounds, () => this.send(surface!)))
      surface.snapshot = previous;
    return surface;
  }
  private send(surface: Surface) {
    if (!this.enabled || !surface.layer || surface.win.isDestroyed()) return;
    surface.win.webContents.send("spark233:event:capsule-state", surface.snapshot);
  }
  private find(id: string) {
    return [...this.options.entries.values()].find((e) => e.noteId === id);
  }
  private open(id: string): Promise<void> {
    const operation = (async () => {
      if (!this.enabled || this.options.canInteract?.() === false) return;
      const e = this.find(id);
      if (!e) return;
      this.hidePreview();
      await this.options.open(id);
      if (!this.enabled || this.find(id) !== e) return;
      e.folded = false;
      await this.refresh();
    })();
    void operation.catch(console.error);
    return operation;
  }
  private hide(id: string) {
    if (!this.enabled || this.options.canInteract?.() === false) return;
    this.hidePreview();
    void this.options.hide(id).catch(console.error);
  }
  private hidePreview() {
    this.previewGeneration += 1;
    this.hover = undefined;
    this.previewId = undefined;
    this.previewAnchor = undefined;
    this.previewEdge = undefined;
    this.leaveSince = 0;
    this.surfaces.get("preview")?.layer?.hide();
  }
  private async showPreview(id: string, anchor: Rect, edge: Edge) {
    if (!this.enabled) return;
    const generation = ++this.previewGeneration;
    const note = await this.options.notes().get(id);
    if (
      !this.enabled ||
      this.hidden ||
      this.systemSuppressed.size ||
      this.drag ||
      generation !== this.previewGeneration ||
      !contains(anchor, screen.getCursorScreenPoint(), 2) ||
      !this.find(id)?.folded
    )
      return;
    const display = screen.getDisplayMatching(anchor);
    this.surface("preview", previewGeometry(display.workArea, anchor, edge), {
      kind: "preview",
      items: [],
      note,
      imageBaseDir: this.options.dataRoot(),
      markdown: note.editorMode === "markdown",
      imageDisplay: this.options.getConfig().imageDisplay,
    });
    this.previewId = id;
    this.previewAnchor = anchor;
    this.previewEdge = edge;
    this.leaveSince = 0;
  }
  private tick() {
    if (this.drag) {
      const owner = BrowserWindow.fromId(this.drag.owner);
      if (
        !owner ||
        owner.isDestroyed() ||
        this.options.canInteract?.() === false ||
        (this.drag.ownerCard && !this.desktopLayer?.isCardVisible(this.drag.ownerCard))
      )
        this.cancelDrag();
      return;
    }
    if (!this.enabled || this.hidden || this.systemSuppressed.size || this.drag) return;
    const point = screen.getCursorScreenPoint(),
      now = Date.now();
    if (this.hover && now >= this.hover.due) {
      const h = this.hover;
      this.hover = undefined;
      if (contains(h.anchor, point, 2))
        void this.showPreview(h.id, h.anchor, h.edge).catch(console.error);
    }
    if (this.previewId) {
      const surface = this.surfaces.get("preview");
      // Only the small gap between capsule and preview retains hover during the crossing.
      const a = this.previewAnchor!,
        b = surface!.win.getBounds();
      const corridor = previewCorridor(a, b, this.previewEdge!);
      if (contains(a, point, 2) || contains(b, point, 2) || contains(corridor, point))
        this.leaveSince = 0;
      else if (!this.leaveSince) this.leaveSince = now;
      else if (now - this.leaveSince > 180) this.hidePreview();
    }
  }
  private beginDrag(surface: Surface, id: string, ownerCard?: string) {
    if (this.drag) throw new AppError("busy", "另一个拖动尚未结束");
    const item = surface.snapshot.items.find((i) => i.id === id);
    if (!item) throw new AppError("invalidPayload", "胶囊不存在");
    const point = screen.getCursorScreenPoint(),
      queue = item.master ? surface.snapshot.key : undefined;
    const entries = queue ? members(this.options.entries.values(), queue) : [this.find(id)!];
    if (entries.some((e) => !e)) throw new AppError("invalidPayload", "便签不存在");
    const timer = setInterval(() => this.moveDrag(), 16);
    this.drag = {
      owner: surface.win.id,
      ownerCard,
      id,
      queue,
      entries,
      start: point,
      point,
      origin: surface.bounds,
      offset: queue
        ? surface.snapshot.edge === "top"
          ? surface.bounds.x - screen.getDisplayMatching(surface.bounds).workArea.x
          : this.queue(queue).offset
        : 0,
      timer,
    };
    this.hidePreview();
  }
  private moveDrag() {
    if (!this.enabled) return;
    const drag = this.drag;
    if (!drag) return;
    const point = screen.getCursorScreenPoint();
    drag.point = point;
    const title = drag.queue ? `spark233 · ${drag.entries.length} 张` : this.title(drag.id),
      width = pillWidth(title);
    this.surface(
      "drag",
      { x: point.x - 20, y: point.y - 16, width, height: PILL_HEIGHT },
      {
        kind: "drag",
        items: [
          {
            id: drag.id,
            title,
            rect: { x: 0, y: 0, width, height: PILL_HEIGHT },
          },
        ],
      },
    );
  }
  private endDrag(cancel = false) {
    const drag = this.drag;
    if (!drag) return;
    clearInterval(drag.timer);
    this.drag = undefined;
    void this.surfaces.get("drag")?.layer?.destroy();
    if (this.options.canInteract?.() === false) cancel = true;
    if (cancel) {
      // Cancellation changes no business/layout data. Repaint the cached
      // controller state without querying a quiescing backend.
      this.render();
      return;
    }
    const point = screen.getCursorScreenPoint(),
      display = screen.getDisplayNearestPoint(point),
      a = display.workArea;
    const edge = nearestEdge({ id: String(display.id), workArea: a }, point),
      key = queueKey(String(display.id), edge);
    const near = edgeDistance(a, edge, point) <= 72;
    if (drag.queue) {
      // Moving along the current edge adjusts the anchor. Pulling away transfers the queue.
      const actual = members(this.options.entries.values(), drag.queue);
      if (actual.length !== drag.entries.length || actual.some((e) => !drag.entries.includes(e))) {
        this.refresh();
        return;
      }
      const source = drag.entries[0].capsule!;
      const horizontal = source.edge === "top";
      const perpendicular = horizontal ? point.y - drag.start.y : point.x - drag.start.x;
      if (
        String(display.id) === source.displayId &&
        Math.abs(perpendicular) < 60 &&
        edgeDistance(a, source.edge, point) <= 72
      ) {
        const current = this.queue(drag.queue);
        const offset = drag.offset + (horizontal ? point.x - drag.start.x : point.y - drag.start.y);
        this.assertCanShow([], { ...current, offset, ...(horizontal ? { centered: false } : {}) });
        current.offset = offset;
        if (horizontal) current.centered = false;
      } else {
        const offset = edge === "top" ? point.x - a.x - 20 : point.y - a.y - 16;
        const collapsed = this.queue(drag.queue).collapsed;
        const peers = members(this.options.entries.values(), key).filter(
          (entry) => !drag.entries.includes(entry),
        );
        this.assertCanShow(
          drag.entries.map((entry, index) => ({
            ...entry,
            capsule: {
              ...entry.capsule!,
              kind: "docked",
              displayId: String(display.id),
              edge,
              order: peers.length + index,
            },
          })),
          { key, offset, collapsed, ...(edge === "top" ? { centered: false } : {}) },
        );
        const target = this.queue(key);
        target.offset = offset;
        if (edge === "top") target.centered = false;
        target.collapsed = collapsed;
        insertMembers(
          [...this.options.entries.values()],
          drag.entries,
          String(display.id),
          edge,
          members(this.options.entries.values(), key).length,
        );
      }
    } else {
      const entry = drag.entries[0];
      if (!entry.visible) {
        this.refresh();
        return;
      }
      if (near || !entry.folded) {
        const group = members(this.options.entries.values(), key).filter((e) => e !== entry),
          q = this.queues.get(key) ?? {
            key,
            offset: edge === "top" ? 0 : 100,
            collapsed: false,
            scroll: 0,
            ...(edge === "top" ? { centered: true } : {}),
          },
          g = queueGeometry(a, edge, q, [
            ...group.map((e) => pillWidth(this.title(e.noteId!))),
            pillWidth(this.title(entry.noteId!)),
          ]);
        const index = queueInsertionIndex(
          group.map((_, i) => g.slot(i)),
          { x: point.x - g.bounds.x, y: point.y - g.bounds.y },
          edge,
        );
        const proposed = [...group];
        proposed.splice(index, 0, entry);
        this.assertCanShow(
          proposed.map((item, order) => ({
            ...item,
            capsule: {
              ...item.capsule!,
              kind: "docked",
              displayId: String(display.id),
              edge,
              order,
            },
          })),
        );
        insertMembers([...this.options.entries.values()], [entry], String(display.id), edge, index);
      } else {
        const placement = {
          ...entry.capsule!,
          kind: "floating" as const,
          displayId: String(display.id),
          x: point.x - 20,
          y: point.y - 16,
        };
        this.assertCanShow({ ...entry, capsule: placement });
        entry.capsule = placement;
      }
    }
    this.save();
    this.refresh();
  }
  private cancelDrag() {
    this.endDrag(true);
  }
  isHidden() {
    return !this.enabled || this.hidden;
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.refreshGeneration += 1;
    if (!enabled) {
      this.titles.clear();
      // Saving belongs to the notes runtime's prepareStop. Keep the durable
      // layout and queue records intact while removing every live surface.
      this.cancelDrag();
      this.hidePreview();
      for (const surface of this.surfaces.values()) void surface.layer?.destroy();
      this.surfaces.clear();
      this.publishLayerQuota();
      this.desktopLayer?.refresh();
    } else this.refresh();
    this.options.changed();
  }
  setHidden(hidden: boolean) {
    if (!hidden && this.hidden && this.desktopLayer) this.assertLayerQuota(this.desktopLayer);
    this.hidden = hidden;
    if (hidden) this.cancelDrag();
    this.hidePreview();
    for (const s of this.surfaces.values()) s.layer?.setSuppressed("user", hidden);
    this.publishLayerQuota();
    this.desktopLayer?.refresh();
    if (!hidden) this.refresh();
    this.options.changed();
  }
  setFullscreen(rects: Rect[]) {
    this.suppressed = rects;
    this.hidePreview();
    this.applyZOrder();
  }
  private applyZOrder() {
    if (!this.enabled) return;
    for (const s of this.surfaces.values()) s.layer?.setFullscreen(this.suppressed);
    LayerWindow.restack([...this.surfaces.values()].flatMap((s) => (s.layer ? [s.layer] : [])));
  }

  async handle(
    win: BrowserWindow,
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.enabled) throw new AppError("pluginDisabled", "便签插件已停用");
    const surface = [...this.surfaces.values()].find((s) => s.layer?.win === win);
    if (!surface) throw new AppError("permissionDenied", "未知胶囊窗口");
    return this.handleSurface(surface, win, command, args);
  }
  private async handleSurface(
    surface: Surface,
    win: BrowserWindow,
    command: string,
    args: Record<string, unknown>,
    ownerCard?: string,
  ): Promise<unknown> {
    if (
      !["desktop_ready", "config_get", "capsule_state"].includes(command) &&
      this.options.canInteract?.() === false
    )
      throw new AppError("pluginStopping", "便签正在保存或停止，请稍后重试");
    switch (command) {
      case "desktop_ready":
        surface.ready = true;
        surface.layer!.markReady();
        this.send(surface);
        if (
          !this.hidden &&
          (surface.snapshot.kind !== "preview" || this.previewId) &&
          (surface.snapshot.kind !== "drag" || this.drag)
        )
          surface.layer!.show();
        return;
      case "shell_open":
        await shell.openExternal(externalUrl(args.url));
        return;
      case "config_get":
        return this.options.getConfig();
      case "capsule_state":
        return surface.snapshot;
      case "capsule_activate": {
        const item = surface.snapshot.items.find((entry) => entry.id === args.id);
        if (!item || surface.snapshot.kind === "drag")
          throw new AppError("permissionDenied", "不属于此窗口的胶囊");
        this.hidePreview();
        if (item.master && surface.snapshot.key) {
          const queue = this.queue(surface.snapshot.key);
          if (queue.collapsed && this.desktopLayer)
            this.assertLayerQuota(this.desktopLayer, undefined, {
              key: queue.key,
              collapsed: false,
            });
          queue.collapsed = !queue.collapsed;
          this.save();
          this.refresh();
        } else if (!item.master) await this.open(item.id);
        return;
      }
      case "capsule_open": {
        const id = String(args.id);
        if (
          surface.snapshot.note?.id !== id &&
          !surface.snapshot.items.some((i) => i.id === id && !i.master)
        )
          throw new AppError("permissionDenied", "不属于此窗口的便签");
        await this.open(id);
        return;
      }
      case "capsule_hover": {
        if (this.drag) return;
        const item = surface.snapshot.items.find((i) => i.id === args.id && !i.master);
        if (!item) return;
        const b = surface.layer ? win.getBounds() : surface.bounds,
          anchor = item.clip
            ? {
                ...item.clip,
                x: b.x + item.rect.x + item.clip.x,
                y: b.y + item.rect.y + item.clip.y,
              }
            : { ...item.rect, x: b.x + item.rect.x, y: b.y + item.rect.y };
        if (!this.find(item.id)?.folded || this.previewId === item.id) return;
        this.hover = {
          id: item.id,
          anchor,
          edge:
            surface.snapshot.edge ??
            nearestEdge({ id: "", workArea: screen.getDisplayMatching(b).workArea }, b),
          owner: win.id,
          due: Date.now() + (this.previewId ? 30 : 220),
        };
        return;
      }
      case "capsule_hide": {
        const item = surface.snapshot.items.find((i) => i.id === args.id && !i.master);
        if (!item || surface.snapshot.kind === "drag")
          throw new AppError("permissionDenied", "不属于此窗口的便签");
        this.hidePreview();
        await this.options.hide(item.id);
        return;
      }
      case "capsule_drag_start":
        this.beginDrag(surface, String(args.id), ownerCard);
        return;
      case "capsule_drag_end":
        if (this.drag?.owner === win.id) this.endDrag(!!args.cancel);
        return;
      case "capsule_scroll":
        if (surface.snapshot.key) {
          const q = this.queue(surface.snapshot.key);
          const scroll = q.scroll + Math.max(-120, Math.min(120, Number(args.delta) || 0));
          // The shared viewport and widget allocator enforce live quotas;
          // scrolling must still reach members hidden by that bounded viewport.
          q.scroll = scroll;
          this.hidePreview();
          this.refresh();
          this.save();
        }
        return;
      case "capsule_menu": {
        this.hidePreview();
        const item = surface.snapshot.items.find((i) => i.id === args.id);
        if (!item) return;
        const menu = item.master
          ? await this.options.globalMenu()
          : Menu.buildFromTemplate([
              { label: this.label("展开便签", "Open note"), click: () => this.open(item.id) },
              { label: this.label("隐藏到托盘", "Hide to tray"), click: () => this.hide(item.id) },
              { type: "separator" },
              {
                label: this.label("移到左侧", "Move to left edge"),
                click: () => this.dock(item.id, "left"),
              },
              {
                label: this.label("移到右侧", "Move to right edge"),
                click: () => this.dock(item.id, "right"),
              },
              {
                label: this.label("移到顶部", "Move to top edge"),
                click: () => this.dock(item.id, "top"),
              },
            ]);
        if (
          this.enabled &&
          !win.isDestroyed() &&
          (this.owns(win) || (ownerCard && this.desktopLayer?.isCardVisible(ownerCard)))
        )
          menu.popup({ window: win });
        return;
      }
      default:
        throw new AppError("permissionDenied", "胶囊窗口不允许此操作");
    }
  }
  private dock(id: string, edge: Edge) {
    if (!this.enabled || this.options.canInteract?.() === false) return;
    const e = this.find(id);
    if (!e) return;
    const d = e.capsule
      ? (screen.getAllDisplays().find((display) => String(display.id) === e.capsule!.displayId) ??
        screen.getDisplayMatching(e.bounds))
      : screen.getDisplayMatching(e.bounds);
    try {
      this.assertCanShow({
        ...e,
        capsule: {
          ...e.capsule!,
          kind: "docked",
          displayId: String(d.id),
          edge,
          order: Number.MAX_SAFE_INTEGER,
        },
      });
    } catch (error) {
      console.error("capsule-quota", error);
      return;
    }
    insertMembers(
      [...this.options.entries.values()],
      [e],
      String(d.id),
      edge,
      Number.MAX_SAFE_INTEGER,
    );
    this.save();
    this.refresh();
  }
  dispose() {
    this.enabled = false;
    this.refreshGeneration += 1;
    this.previewGeneration += 1;
    clearInterval(this.ticker);
    if (this.drag) {
      clearInterval(this.drag.timer);
      this.drag = undefined;
    }
    this.releaseEnvironment();
    this.releaseDesktopLayer?.();
    for (const s of this.surfaces.values()) void s.layer?.destroy();
    this.surfaces.clear();
  }
}
