import { BrowserWindow, Menu, screen, shell } from "electron";
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
}
interface Surface {
  win: BrowserWindow;
  snapshot: CapsuleSnapshot;
  ready: boolean;
}
interface Drag {
  owner: number;
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
  private titles = new Map<string, string>();
  private refreshGeneration = 0;
  private previewGeneration = 0;
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
    screen.on("display-added", this.displayChanged);
    screen.on("display-removed", this.displayChanged);
    screen.on("display-metrics-changed", this.displayChanged);
  }
  private displayChanged = () => {
    if (!this.enabled) return;
    this.cancelDrag();
    this.hidePreview();
    this.refresh();
    this.save();
  };
  owns(win: BrowserWindow) {
    return [...this.surfaces.values()].some((s) => s.win === win);
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
    const before = {
      folded: entry.folded,
      visible: entry.visible,
      capsule: entry.capsule ? { ...entry.capsule } : undefined,
    };
    try {
      const display = screen.getDisplayMatching(entry.bounds),
        point = {
          x: entry.bounds.x + entry.bounds.width / 2,
          y: entry.bounds.y + entry.bounds.height / 2,
        };
      if (!entry.capsule)
        entry.capsule = {
          kind: "docked",
          displayId: String(display.id),
          edge: nearestEdge({ id: String(display.id), workArea: display.workArea }, point),
          order: 0,
          x: entry.bounds.x,
          y: entry.bounds.y,
        };
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
      for (let i = 0; surface && !surface.ready && i < 60; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
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
        // The pointer-capture owner stays alive until drop/cancel, even if its queue empties.
        if (this.drag?.owner === s.win.id) s.win.hide();
        else {
          s.win.destroy();
          this.surfaces.delete(key);
        }
      }
    if (
      this.previewId &&
      !entries.some((e) => e.noteId === this.previewId && e.visible && e.folded)
    )
      this.hidePreview();
    this.applyZOrder();
  }
  private title(id: string) {
    return this.titles.get(id) ?? "无标题便签";
  }
  private surface(key: string, bounds: Rect, snapshot: CapsuleSnapshot): Surface {
    if (!this.enabled) throw new AppError("pluginDisabled", "便签插件已停用");
    let surface = this.surfaces.get(key);
    if (!surface) {
      const win = new BrowserWindow({
        ...bounds,
        title: this.label("spark233 胶囊", "spark233 capsules"),
        frame: false,
        transparent: true,
        show: false,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        hasShadow: false,
        webPreferences: {
          preload: path.join(this.options.here, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: true,
          additionalArguments: [`--spark233-label=capsule:${key}`],
        },
      });
      surface = { win, snapshot, ready: false };
      this.surfaces.set(key, surface);
      win.webContents.on("render-process-gone", (_event, details) => {
        this.options.onRendererCrash?.(
          new Error(`Notes capsule renderer exited: ${details.reason} (${details.exitCode})`),
        );
      });
      win.setMenu(null);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());
      win.webContents.on("will-attach-webview", (e) => e.preventDefault());
      win.on("closed", () => {
        if (this.surfaces.get(key)?.win === win) this.surfaces.delete(key);
      });
      void win.loadURL(`${this.options.url}?view=capsule`).catch((error) => {
        if (!win.isDestroyed()) console.error(error);
      });
    }
    surface.snapshot = snapshot;
    surface.win.setBounds(bounds);
    if (process.platform === "win32" || process.platform === "linux") {
      const shape =
        snapshot.kind === "queue"
          ? snapshot.items.map((i) => {
              const r = i.clip
                ? { ...i.clip, x: i.rect.x + i.clip.x, y: i.rect.y + i.clip.y }
                : i.rect;
              return {
                x: Math.floor(r.x),
                y: Math.floor(r.y),
                width: Math.ceil(r.x + r.width) - Math.floor(r.x),
                height: Math.ceil(r.y + r.height) - Math.floor(r.y),
              };
            })
          : [{ x: 0, y: 0, width: bounds.width, height: bounds.height }];
      surface.win.setShape(shape);
    }
    if (surface.ready) {
      this.send(surface);
      if (!this.hidden) surface.win.showInactive();
    }
    return surface;
  }
  private send(surface: Surface) {
    if (!this.enabled || surface.win.isDestroyed()) return;
    surface.win.webContents.send("spark233:event:capsule-state", surface.snapshot);
  }
  private find(id: string) {
    return [...this.options.entries.values()].find((e) => e.noteId === id);
  }
  private open(id: string): Promise<void> {
    const operation = (async () => {
      if (!this.enabled) return;
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
    if (!this.enabled) return;
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
    this.surfaces.get("preview")?.win.hide();
  }
  private async showPreview(id: string, anchor: Rect, edge: Edge) {
    if (!this.enabled) return;
    const generation = ++this.previewGeneration;
    const note = await this.options.notes().get(id);
    if (
      !this.enabled ||
      this.hidden ||
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
    if (!this.enabled || this.hidden || this.drag) return;
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
  private beginDrag(surface: Surface, id: string) {
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
      id,
      queue,
      entries,
      start: point,
      point,
      origin: surface.win.getBounds(),
      offset: queue
        ? surface.snapshot.edge === "top"
          ? surface.win.getBounds().x -
            screen.getDisplayMatching(surface.win.getBounds()).workArea.x
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
    this.surfaces.get("drag")?.win.setIgnoreMouseEvents(true);
  }
  private endDrag(cancel = false) {
    const drag = this.drag;
    if (!drag) return;
    clearInterval(drag.timer);
    this.drag = undefined;
    this.surfaces.get("drag")?.win.destroy();
    if (cancel) {
      this.refresh();
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
        current.offset =
          drag.offset + (horizontal ? point.x - drag.start.x : point.y - drag.start.y);
        if (horizontal) current.centered = false;
      } else {
        const target = this.queue(key);
        target.offset = edge === "top" ? point.x - a.x - 20 : point.y - a.y - 16;
        if (edge === "top") target.centered = false;
        target.collapsed = this.queue(drag.queue).collapsed;
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
          q = this.queue(key),
          g = queueGeometry(a, edge, q, [
            ...group.map((e) => pillWidth(this.title(e.noteId!))),
            pillWidth(this.title(entry.noteId!)),
          ]);
        const index = queueInsertionIndex(
          group.map((_, i) => g.slot(i)),
          { x: point.x - g.bounds.x, y: point.y - g.bounds.y },
          edge,
        );
        insertMembers([...this.options.entries.values()], [entry], String(display.id), edge, index);
      } else
        entry.capsule = {
          ...entry.capsule!,
          kind: "floating",
          displayId: String(display.id),
          x: point.x - 20,
          y: point.y - 16,
        };
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
      for (const surface of this.surfaces.values()) surface.win.destroy();
      this.surfaces.clear();
    } else this.refresh();
    this.options.changed();
  }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.hidePreview();
    for (const s of this.surfaces.values()) s.win.hide();
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
    for (const s of this.surfaces.values()) {
      const bounds = s.win.getBounds(),
        blocked = this.suppressed.some((r) =>
          contains(r, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
        );
      // Avoid the default Windows restack behind a lowered primary taskbar.
      s.win.setAlwaysOnTop(!blocked, process.platform === "win32" ? "pop-up-menu" : "floating");
    }
  }
  async handle(
    win: BrowserWindow,
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.enabled) throw new AppError("pluginDisabled", "便签插件已停用");
    const surface = [...this.surfaces.values()].find((s) => s.win === win);
    if (!surface) throw new AppError("permissionDenied", "未知胶囊窗口");
    switch (command) {
      case "desktop_ready":
        surface.ready = true;
        this.send(surface);
        if (
          !this.hidden &&
          (surface.snapshot.kind !== "preview" || this.previewId) &&
          (surface.snapshot.kind !== "drag" || this.drag)
        )
          win.showInactive();
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
        const b = win.getBounds(),
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
        this.beginDrag(surface, String(args.id));
        return;
      case "capsule_drag_end":
        if (this.drag?.owner === win.id) this.endDrag(!!args.cancel);
        return;
      case "capsule_scroll":
        if (surface.snapshot.key) {
          const q = this.queue(surface.snapshot.key);
          q.scroll += Math.max(-120, Math.min(120, Number(args.delta) || 0));
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
        if (this.enabled && !win.isDestroyed() && this.owns(win)) menu.popup({ window: win });
        return;
      }
      default:
        throw new AppError("permissionDenied", "胶囊窗口不允许此操作");
    }
  }
  private dock(id: string, edge: Edge) {
    if (!this.enabled) return;
    const e = this.find(id);
    if (!e) return;
    const d = e.capsule
      ? (screen.getAllDisplays().find((display) => String(display.id) === e.capsule!.displayId) ??
        screen.getDisplayMatching(e.bounds))
      : screen.getDisplayMatching(e.bounds);
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
    for (const s of this.surfaces.values()) s.win.destroy();
    this.surfaces.clear();
    screen.removeListener("display-added", this.displayChanged);
    screen.removeListener("display-removed", this.displayChanged);
    screen.removeListener("display-metrics-changed", this.displayChanged);
  }
}
