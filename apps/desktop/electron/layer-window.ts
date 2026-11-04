import type { BrowserWindow, BrowserWindowConstructorOptions, Screen } from "electron";
import type { EventEmitter } from "node:events";
import type { Rect } from "../src/features/capsules/types.js";
import type {
  LayerCard,
  LayerGroup,
  LayerInputMode,
  SurfaceKey,
} from "../shared/layer-contract.js";
import { contains, intersectRect } from "./capsule-layout.js";

export function surfaceKey(card: LayerCard): SurfaceKey {
  return JSON.stringify([card.displayId, card.group, card.inputMode]);
}

// Electron's native bounds require integers; round the window and hit regions
// around the same origin. Existing capsule helpers intersect DIPs but do not
// normalize a native window rectangle, so this adapter keeps that boundary here.
function nativeBounds(bounds: Rect): Rect {
  const x = Math.floor(bounds.x),
    y = Math.floor(bounds.y);
  return {
    x,
    y,
    width: Math.ceil(bounds.x + bounds.width) - x,
    height: Math.ceil(bounds.y + bounds.height) - y,
  };
}

/** Screen DIP -> client DIP. Union AFTER outward rounding, without scaling by DPI. */
export function computeShape(cards: readonly LayerCard[], area: Rect): Rect[] {
  const rects: Rect[] = [];
  for (const card of cards) {
    if (!card.visible) continue;
    const clipped = card.clip
      ? intersectRect(card.bounds, {
          ...card.clip,
          x: card.bounds.x + card.clip.x,
          y: card.bounds.y + card.clip.y,
        })
      : card.bounds;
    const effective = clipped && intersectRect(clipped, area);
    if (!effective) continue;
    const x = Math.floor(effective.x - area.x),
      y = Math.floor(effective.y - area.y);
    const width = Math.ceil(effective.x + effective.width - area.x) - x;
    const height = Math.ceil(effective.y + effective.height - area.y) - y;
    if (width > 0 && height > 0) rects.push({ x, y, width, height });
  }
  // Sweep horizontal bands, union each band's x intervals, then merge equal
  // adjacent bands. Duplicate/overlapping cards never create overlapping shapes.
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.height]))].sort((a, b) => a - b);
  const result: Rect[] = [];
  let previous = new Map<string, Rect>();
  for (let i = 1; i < ys.length; i++) {
    const y = ys[i - 1],
      bottom = ys[i];
    const spans = rects.filter((r) => r.y < bottom && r.y + r.height > y).sort((a, b) => a.x - b.x);
    const merged: Rect[] = [];
    for (const r of spans) {
      const last = merged.at(-1);
      if (last && r.x <= last.x + last.width)
        last.width = Math.max(last.x + last.width, r.x + r.width) - last.x;
      else merged.push({ x: r.x, y, width: r.width, height: bottom - y });
    }
    const current = new Map<string, Rect>();
    for (const r of merged) {
      const key = `${r.x}:${r.width}`,
        above = previous.get(key);
      if (above && above.y + above.height === y) above.height += r.height;
      else result.push(r);
      current.set(key, above && above.y + above.height === bottom ? above : r);
    }
    previous = current;
  }
  return result;
}

interface Timers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}
interface EnvironmentOptions {
  screen: Pick<EventEmitter, "on" | "removeListener">;
  powerMonitor: Pick<EventEmitter, "on" | "removeListener">;
  timers: Timers;
  onDisplayChange: () => void;
  onSuppressed: (reason: "locked" | "suspend", value: boolean) => void;
  onRestore: () => void;
}

// M0 adapts the existing trusted capsule shell. Shared-layer resources will be
// supplied by DesktopLayer in M1; Web URL/session ownership stays with WidgetHost.
// This class never chooses plugin URLs, renders cards, sends IPC or stops owners.
export interface LayerWindowOptions {
  id: string;
  mode: "shared" | "web-shell" | "notes-preview" | "notes-drag";
  bounds: Rect;
  group: LayerGroup;
  inputMode: LayerInputMode;
  fullscreenBehavior?: "lower" | "hide" | "keep";
  order?: number;
  title: string;
  entryURL: string;
  preloadPath: string;
  session?: Electron.Session;
  label: string;
  additionalArguments?: string[];
  screen: Pick<Screen, "getDisplayMatching">;
  createBrowserWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  timers: Timers;
  diagnostic: (code: string, error: Error) => void;
  onClosed: () => void;
}

export class LayerWindow {
  readonly win: BrowserWindow;
  readonly id: string;
  ready = false;
  private bounds: Rect;
  private appliedBounds?: Rect;
  private appliedShape?: readonly Rect[];
  private appliedTopmost?: boolean;
  private hasShape = false;
  private wanted = false;
  private disposed = false;
  private presentationPending = false;
  private suppressed = new Set<"fullscreen" | "locked" | "suspend" | "user">();
  private fullscreen: readonly Rect[] = [];
  private loadTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: LayerWindowOptions) {
    this.id = options.id;
    this.bounds = nativeBounds(options.bounds);
    this.win = options.createBrowserWindow({
      ...this.bounds,
      title: options.title,
      // Windows/Chromium excludes native tool windows from occlusion tracking.
      // skipTaskbar alone does not set WS_EX_TOOLWINDOW; a small rectangular
      // shape on a screen-sized HWND can otherwise occlude the app beneath it.
      ...(process.platform === "win32" ? { type: "toolbar" } : {}),
      frame: false,
      transparent: true,
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: options.group === "top",
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: options.preloadPath,
        session: options.session,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        allowRunningInsecureContent: false,
        sandbox: true,
        webSecurity: true,
        // The hidden shared shell must run its first React effect to report
        // ready, then owns its heartbeat. Keep legacy/Web scheduling unchanged.
        backgroundThrottling: options.mode !== "shared",
        additionalArguments: [
          `--spark233-label=${options.label}`,
          ...(options.additionalArguments ?? []),
        ],
      },
    });
    const win = this.win;
    win.setIgnoreMouseEvents(options.inputMode === "passive");
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-redirect", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    win.webContents.on("render-process-gone", (_event, details) => {
      options.diagnostic(
        "renderer-gone",
        new Error(`Layer renderer exited: ${details.reason} (${details.exitCode})`),
      );
    });
    // OS display/DPI adjustments can move a surface independently of apply().
    // Reconcile the requested rectangle again after those native changes.
    const nativeGeometryChanged = () => {
      if (this.disposed) return;
      const actual = win.getBounds(),
        previous = this.appliedBounds;
      if (
        previous &&
        actual.x === previous.x &&
        actual.y === previous.y &&
        actual.width === previous.width &&
        actual.height === previous.height
      )
        return;
      this.appliedBounds = actual;
      this.appliedShape = undefined;
    };
    win.on("move", nativeGeometryChanged);
    win.on("resize", nativeGeometryChanged);
    win.on("closed", () => {
      this.disposed = true;
      this.clearLoadTimer();
      options.onClosed();
    });
    this.loadTimer = options.timers.setTimeout(() => {
      this.loadTimer = undefined;
      if (!this.disposed && !this.ready)
        options.diagnostic(
          "load-timeout",
          new Error(`Layer window ${this.id} did not become ready within 5 s`),
        );
    }, 5000);
    void win.loadURL(options.entryURL).catch((error: Error) => {
      if (!this.disposed) options.diagnostic("load-failed", error);
    });
  }

  /** One subscription per controller, including while it owns zero windows. */
  static observeEnvironment(options: EnvironmentOptions): () => void {
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const blocked = new Set<"locked" | "suspend">();
    const recovering = new Set<"locked" | "suspend">();
    const cancelRestore = () => {
      if (restoreTimer !== undefined) options.timers.clearTimeout(restoreTimer);
      restoreTimer = undefined;
    };
    const suppress = (reason: "locked" | "suspend") => {
      cancelRestore();
      blocked.add(reason);
      recovering.add(reason);
      options.onSuppressed(reason, true);
    };
    const restore = (reason: "locked" | "suspend") => {
      blocked.delete(reason);
      if (blocked.size) return;
      cancelRestore();
      restoreTimer = options.timers.setTimeout(() => {
        restoreTimer = undefined;
        // Reconcile geometry/publish a complete legacy snapshot before showing.
        options.onDisplayChange();
        for (const recovered of recovering) options.onSuppressed(recovered, false);
        recovering.clear();
        options.onRestore();
      }, 2000);
    };
    const lock = () => suppress("locked"),
      suspend = () => suppress("suspend");
    const unlock = () => restore("locked"),
      resume = () => restore("suspend");
    options.screen.on("display-added", options.onDisplayChange);
    options.screen.on("display-removed", options.onDisplayChange);
    options.screen.on("display-metrics-changed", options.onDisplayChange);
    options.powerMonitor.on("lock-screen", lock);
    options.powerMonitor.on("suspend", suspend);
    options.powerMonitor.on("unlock-screen", unlock);
    options.powerMonitor.on("resume", resume);
    return () => {
      cancelRestore();
      options.screen.removeListener("display-added", options.onDisplayChange);
      options.screen.removeListener("display-removed", options.onDisplayChange);
      options.screen.removeListener("display-metrics-changed", options.onDisplayChange);
      options.powerMonitor.removeListener("lock-screen", lock);
      options.powerMonitor.removeListener("suspend", suspend);
      options.powerMonitor.removeListener("unlock-screen", unlock);
      options.powerMonitor.removeListener("resume", resume);
    };
  }

  apply(cards: readonly LayerCard[], bounds: Rect, publish: () => void): boolean {
    if (this.disposed) return false;
    const actualBounds = nativeBounds(bounds);
    const shape = computeShape(cards, actualBounds);
    if (shape.length > 128) {
      this.options.diagnostic(
        "shape-limit",
        new Error(`Layer window ${this.id} exceeds 128 shape rectangles`),
      );
      return false;
    }
    this.bounds = actualBounds;
    this.hasShape = shape.length > 0;
    // An empty native shape resets to the full window rectangle, so visibility
    // must change before setShape even when geometry otherwise stays unchanged.
    if (!this.hasShape || this.isHidden()) this.hideNative();
    const old = this.appliedBounds;
    const boundsChanged =
      !old ||
      old.x !== actualBounds.x ||
      old.y !== actualBounds.y ||
      old.width !== actualBounds.width ||
      old.height !== actualBounds.height;
    if (boundsChanged) {
      this.win.setBounds(actualBounds);
      this.appliedBounds = actualBounds;
    }
    if (
      (process.platform === "win32" || process.platform === "linux") &&
      (boundsChanged ||
        !this.appliedShape ||
        shape.length !== this.appliedShape.length ||
        shape.some((rect, index) => {
          const previous = this.appliedShape![index]!;
          return (
            rect.x !== previous.x ||
            rect.y !== previous.y ||
            rect.width !== previous.width ||
            rect.height !== previous.height
          );
        }))
    ) {
      this.win.setShape(shape);
      this.appliedShape = shape;
    }
    this.applyZOrder();
    if (this.ready) {
      publish();
      this.show();
    }
    return true;
  }

  markReady(): void {
    if (this.disposed) return;
    this.ready = true;
    this.clearLoadTimer();
  }
  /** Display/DPI/session changes must reapply native state even at equal DIP bounds. */
  invalidateGeometry(): void {
    this.appliedBounds = undefined;
    this.appliedShape = undefined;
    this.appliedTopmost = undefined;
  }
  /** Preserve the HWND/WebContents while replacing an operation viewport. */
  beginPresentation(): void {
    if (this.disposed) return;
    this.presentationPending = true;
    this.hideNative();
    if (process.platform === "win32" || process.platform === "linux") this.win.setShape([]);
    this.invalidateGeometry();
  }
  completePresentation(): void {
    this.presentationPending = false;
    if (this.wanted) this.show();
  }
  setPresentation(group: LayerGroup, inputMode: LayerInputMode): void {
    if (this.options.group === group && this.options.inputMode === inputMode) return;
    this.options.group = group;
    this.options.inputMode = inputMode;
    this.applyZOrder(true);
  }
  show(): void {
    this.wanted = true;
    if (
      !this.disposed &&
      this.ready &&
      this.hasShape &&
      !this.isHidden() &&
      !this.win.isVisible()
    ) {
      // Showing may follow an OS hide/restore; reassert the native level once.
      this.applyZOrder(true);
      this.win.showInactive();
    }
  }
  hide(): void {
    this.wanted = false;
    this.hideNative();
  }
  private hideNative(): void {
    if (!this.disposed && this.win.isVisible()) this.win.hide();
  }
  setSuppressed(reason: "fullscreen" | "locked" | "suspend" | "user", value: boolean): void {
    if (this.disposed || this.suppressed.has(reason) === value) return;
    const wasHidden = this.isHidden();
    if (value) this.suppressed.add(reason);
    else this.suppressed.delete(reason);
    if (this.disposed) return;
    this.applyZOrder();
    if (this.isHidden()) this.hideNative();
    else if (wasHidden && this.wanted) this.show();
  }
  setFullscreen(rects: readonly Rect[]): void {
    if (
      this.disposed ||
      (rects.length === this.fullscreen.length &&
        rects.every((rect, index) => {
          const previous = this.fullscreen[index]!;
          return (
            rect.x === previous.x &&
            rect.y === previous.y &&
            rect.width === previous.width &&
            rect.height === previous.height
          );
        }))
    )
      return;
    const wasHidden = this.isHidden();
    this.fullscreen = rects.map((rect) => ({ ...rect }));
    this.applyZOrder();
    if (this.disposed) return;
    if (this.isHidden()) this.hideNative();
    else if (wasHidden && this.wanted) this.show();
  }
  setFullscreenBehavior(value: "lower" | "hide" | "keep"): void {
    if (this.options.fullscreenBehavior === value) return;
    const wasHidden = this.isHidden();
    this.options.fullscreenBehavior = value;
    if (this.disposed) return;
    this.applyZOrder();
    if (this.isHidden()) this.hideNative();
    else if (wasHidden && this.wanted) this.show();
  }
  private isHidden(): boolean {
    return (
      this.presentationPending ||
      [...this.suppressed].some((reason) => reason !== "fullscreen") ||
      (this.options.fullscreenBehavior !== "lower" &&
        this.options.fullscreenBehavior !== "keep" &&
        this.fullscreenBlocked())
    );
  }
  private applyZOrder(force = false): void {
    if (this.disposed) return;
    const topmost = this.options.group === "top" && !this.fullscreenBlocked();
    if (!force && this.appliedTopmost === topmost) return;
    this.win.setAlwaysOnTop(topmost, process.platform === "win32" ? "pop-up-menu" : "floating");
    this.appliedTopmost = topmost;
  }
  private fullscreenBlocked(): boolean {
    return (
      this.options.fullscreenBehavior !== "keep" &&
      (this.suppressed.has("fullscreen") ||
        this.fullscreen.some((r) =>
          contains(r, {
            x: this.bounds.x + this.bounds.width / 2,
            y: this.bounds.y + this.bounds.height / 2,
          }),
        ))
    );
  }
  /** HWND order only; a shared renderer remains responsible for its cards' order/id. */
  static restack(layers: readonly LayerWindow[]): void {
    const priority = (layer: LayerWindow) =>
      layer.options.mode === "notes-preview" || layer.options.mode === "notes-drag"
        ? 4
        : (layer.options.group === "top" ? 2 : 0) +
          (layer.options.inputMode === "interactive" ? 1 : 0);
    const sorted = [...layers].sort(
      (a, b) =>
        priority(a) - priority(b) ||
        (a.options.order ?? 0) - (b.options.order ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    let previous: LayerWindow | undefined;
    for (const layer of sorted) {
      layer.applyZOrder();
      // Never raise a surface suppressed by fullscreen avoidance.
      if (layer.disposed || !layer.win.isVisible() || layer.fullscreenBlocked()) continue;
      if (previous && previous.options.group === layer.options.group)
        layer.win.moveAbove(previous.win.getMediaSourceId());
      previous = layer;
    }
  }
  /** Display lookup stays injected; legacy consumers rebuild their own geometry. */
  display(bounds: Rect = this.bounds): ReturnType<Screen["getDisplayMatching"]> {
    return this.options.screen.getDisplayMatching(bounds);
  }
  destroy(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.clearLoadTimer();
      this.win.destroy();
    }
    return Promise.resolve();
  }
  private clearLoadTimer(): void {
    if (this.loadTimer !== undefined) this.options.timers.clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
  }
}
