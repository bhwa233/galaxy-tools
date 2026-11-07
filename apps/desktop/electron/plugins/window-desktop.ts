import { randomUUID } from "node:crypto";
import { screen, type BrowserWindow } from "electron";
import type { WindowMode } from "../../shared/window-mode.js";
import type { LayerCard, LayerInstanceSummary } from "../../shared/layer-contract.js";
import type { ExternalLayerPresentation } from "../../shared/utools-desktop.js";
import type { Rect } from "../../src/features/capsules/types.js";
import type { DesktopLayer } from "../desktop-layer.js";
import {
  constrainLayerCard,
  DEFAULT_LAYER_QUOTAS,
  type LayerLayoutStore,
  type StoredLayerCard,
} from "../layer-layout-store.js";
import { AppError } from "../persistence.js";
import { contains } from "../capsule-layout.js";

type WindowCard = Extract<StoredLayerCard, { kind: "window" }>;

/** What the window owner applies; `null` returns it to an ordinary window. */
export type PluginWindowPresentation = (ExternalLayerPresentation & { revision: number }) | null;

interface Session {
  pluginId: string;
  profile: string;
  title: () => string;
  present(value: PluginWindowPresentation): void | Promise<void>;
  release?: () => void;
  revision: number;
  focused: boolean;
  failure?: string;
}

const key = (pluginId: string, profile: string) => JSON.stringify([pluginId, profile]);

/**
 * Keeps plugin windows (host status bar shells) on the desktop. The window stays
 * owned by its plugin runtime; this host only stores the card, registers it with
 * the desktop layer and forwards the layer's presentation to the owner.
 */
export class PluginWindowDesktopHost {
  private sessions = new Map<string, Session>();
  constructor(
    private readonly options: {
      layer: DesktopLayer;
      store: LayerLayoutStore;
      /** Opens a plugin window that should be restored after a restart. */
      openWindow: (pluginId: string, profile: string) => Promise<void>;
      /** Whether a plugin is installed, enabled and healthy. */
      available: (pluginId: string) => boolean;
    },
  ) {
    options.layer.register({
      id: "plugin-windows",
      snapshot: () => this.cards(),
      // "Open" from the plugin bar returns the window to an ordinary window.
      onInvoke: async (id) => {
        const card = this.options.store.load().cards[id];
        if (card?.kind === "window") await this.remove(card.windowInstanceId);
      },
    });
  }

  private stored(): Array<[string, WindowCard]> {
    return Object.entries(this.options.store.load().cards).filter(
      (entry): entry is [string, WindowCard] => entry[1].kind === "window",
    );
  }
  private find(pluginId: string, profile: string): [string, WindowCard] | undefined {
    return this.stored().find(([, c]) => c.pluginId === pluginId && c.windowProfile === profile);
  }
  private cards(): LayerCard[] {
    return this.stored().flatMap(([id, card]) => {
      const session = this.sessions.get(key(card.pluginId, card.windowProfile));
      if (!session) return [];
      return [
        {
          id,
          title: session.title(),
          ...card,
          renderKind: "window" as const,
          renderRef: card.windowInstanceId,
          fullscreenAutoHide: false,
        },
      ];
    });
  }

  /** Whether this window is currently kept on the desktop. */
  pinned(pluginId: string, profile: string): boolean {
    return !!this.find(pluginId, profile);
  }

  /**
   * Called by the window owner whenever its window exists. Returns the request
   * handler for the window's own status bar; dispose releases the registration.
   */
  attach(input: Omit<Session, "revision" | "focused" | "release" | "failure">): {
    pin(bounds: Rect): Promise<void>;
    unpin(): Promise<void>;
    focus(focused: boolean): void;
    bounds(bounds: Rect): Promise<void>;
    dispose(): void;
  } {
    const id = key(input.pluginId, input.profile);
    const session: Session = { ...input, revision: 0, focused: false };
    this.sessions.get(id)?.release?.();
    this.sessions.set(id, session);
    this.register(session);
    const current = () => this.sessions.get(id) === session;
    return {
      pin: async (bounds) => {
        if (!current()) throw new AppError("pluginStopping", "插件窗口已失效");
        if (!this.options.layer.options.flags().enabled)
          throw new AppError("layer.disabled", "请先在设置中开启桌面插件层");
        const previous = this.find(input.pluginId, input.profile);
        if (previous) return this.update(previous[1].windowInstanceId, { visible: true });
        const displays = this.options.layer.options.displays();
        const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const display =
          displays.find((d) => contains(d.workArea, center)) ??
          displays.find((d) => d.id === this.options.layer.options.primaryDisplay()) ??
          displays[0];
        if (!display) throw new AppError("layer.displayUnavailable", "当前没有可用显示器");
        const layout = this.options.store.load();
        const active = Object.values(layout.cards).filter((c) => c.visible);
        if (
          active.length >= DEFAULT_LAYER_QUOTAS.total ||
          active.filter((c) => c.displayId === display.id).length >= DEFAULT_LAYER_QUOTAS.perDisplay
        )
          throw new AppError("layer.quotaExceeded", "桌面插件数量已达上限");
        const instance = randomUUID();
        const card: WindowCard = {
          kind: "window",
          pluginId: input.pluginId,
          windowProfile: input.profile,
          windowInstanceId: instance,
          displayId: display.id,
          workAreaAtSave: display.workArea,
          bounds,
          group: "normal",
          inputMode: "interactive",
          order: Date.now(),
          visible: true,
          restore: true,
          createdAt: Date.now(),
        };
        layout.cards[`window:${instance}`] = constrainLayerCard(
          card,
          displays,
          this.options.layer.options.primaryDisplay(),
        ).card;
        await this.options.store.commit(
          { ...layout, revision: layout.revision + 1 },
          layout.revision,
        );
        this.register(session);
        this.options.layer.refresh();
      },
      unpin: async () => {
        const stored = this.find(input.pluginId, input.profile);
        if (stored) await this.remove(stored[1].windowInstanceId);
      },
      focus: (focused) => {
        session.focused = focused;
        if (focused) this.options.layer.restackOverlay();
      },
      bounds: async (bounds) => {
        const stored = this.find(input.pluginId, input.profile);
        if (!stored || !current()) return;
        await this.options.layer.externalBounds(stored[0], bounds);
      },
      dispose: () => {
        if (!current()) return;
        session.release?.();
        this.sessions.delete(id);
        this.options.layer.refresh();
      },
    };
  }

  private register(session: Session): void {
    if (session.release) return;
    const entry = this.find(session.pluginId, session.profile);
    if (!entry) return;
    const [id] = entry;
    session.release = this.options.layer.registerExternal(id, {
      present: async (value) => {
        const revision = ++session.revision;
        try {
          await session.present({ ...value, revision });
          session.failure = undefined;
        } catch (error) {
          session.failure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      focus: () => session.focused,
      restack: () => {
        const current = this.options.layer.externalPresentation(id);
        if (current && this.options.layer.overlayActive)
          void Promise.resolve(session.present({ ...current, revision: session.revision })).catch(
            () => {},
          );
      },
      update: (patch) => this.update(entry[1].windowInstanceId, patch),
    });
  }

  /** Reopens windows kept on the desktop, e.g. after a restart. */
  async sync(): Promise<void> {
    if (!this.options.layer.options.flags().enabled) return;
    for (const [, card] of this.stored()) {
      if (!card.restore || !card.visible) continue;
      if (this.sessions.has(key(card.pluginId, card.windowProfile))) continue;
      if (!this.options.available(card.pluginId)) continue;
      try {
        await this.options.openWindow(card.pluginId, card.windowProfile);
      } catch (error) {
        console.error("plugin-window-restore", card.pluginId, error);
      }
    }
    this.options.layer.refresh();
  }

  has(id: string): boolean {
    return this.stored().some(([, card]) => card.windowInstanceId === id);
  }
  quotaCards(): LayerCard[] {
    return this.cards();
  }
  list(): LayerInstanceSummary[] {
    return this.stored().map(([, card]) => {
      const session = this.sessions.get(key(card.pluginId, card.windowProfile));
      return {
        title: session?.title() ?? card.pluginId,
        widgetInstanceId: card.windowInstanceId,
        pluginId: card.pluginId,
        widgetDefinitionId: `window:${card.windowProfile}`,
        displayId: card.displayId,
        visible: card.visible,
        group: card.group,
        inputMode: card.inputMode,
        bounds: card.bounds,
        status: !session
          ? this.options.available(card.pluginId)
            ? "hidden"
            : "orphan"
          : session.failure
            ? "fault"
            : !this.options.layer.options.flags().enabled
              ? "suspended"
              : card.visible
                ? "active"
                : "hidden",
        reason: session?.failure,
      };
    });
  }
  async update(
    id: string,
    patch: { visible?: boolean; group?: "normal" | "top"; inputMode?: "passive" | "interactive" },
  ): Promise<void> {
    const layout = this.options.store.load();
    const entry = layout.cards[`window:${id}`];
    if (entry?.kind !== "window") throw new AppError("layer.card.invalid", "桌面窗口已移除");
    layout.cards[`window:${id}`] = { ...entry, ...patch };
    await this.options.store.commit({ ...layout, revision: layout.revision + 1 }, layout.revision);
    if (patch.visible) await this.sync();
    this.options.layer.refresh();
  }
  /** Returns the window to an ordinary window; its page and state stay alive. */
  async remove(id: string): Promise<void> {
    const card = this.options.store.load().cards[`window:${id}`];
    if (card?.kind !== "window") return;
    const session = this.sessions.get(key(card.pluginId, card.windowProfile));
    if (this.options.layer.overlayActive) await this.options.layer.closeOverlay(false);
    session?.release?.();
    if (session) session.release = undefined;
    await this.options.store.removeWindow(id);
    if (session) await session.present(null);
    this.options.layer.refresh();
  }
  async retry(id: string): Promise<void> {
    const card = this.options.store.load().cards[`window:${id}`];
    if (card?.kind !== "window") throw new AppError("layer.card.invalid", "桌面窗口已移除");
    const session = this.sessions.get(key(card.pluginId, card.windowProfile));
    if (session) {
      session.release?.();
      session.release = undefined;
      session.failure = undefined;
      this.register(session);
    }
    await this.sync();
  }
}

/**
 * Window mode of one plugin window (Web shell or official workspace): normal,
 * always on top, or kept on the desktop through PluginWindowDesktopHost. It
 * applies the desktop layer's projection to the existing window and restores
 * the ordinary window when it leaves the desktop; the page is never reloaded.
 */
export class WindowModeController {
  mode: WindowMode = "normal";
  private link?: ReturnType<PluginWindowDesktopHost["attach"]>;
  private presented?: Exclude<PluginWindowPresentation, null>;
  private ordinaryBounds?: Electron.Rectangle;
  private ordinaryMaximized = false;
  private disposed = false;

  constructor(
    private readonly o: {
      window: BrowserWindow;
      desktop?: PluginWindowDesktopHost;
      pluginId: string;
      profile: string;
      title: () => string;
      /** Whether the ordinary window shows in the taskbar. */
      taskbar: () => boolean;
      /** Applies "always on top" the owner's way (host windows persist it). */
      setTopmost?: (value: boolean) => void;
      onChange: () => void;
    },
  ) {
    const { window } = o;
    if (o.desktop)
      this.link = o.desktop.attach({
        pluginId: o.pluginId,
        profile: o.profile,
        title: o.title,
        present: (value) => this.present(value),
      });
    window.on("moved", () => this.report());
    window.on("resized", () => this.report());
    window.on("focus", () => this.link?.focus(true));
    window.on("blur", () => this.link?.focus(false));
    window.once("closed", () => this.dispose());
  }
  get desktopAvailable(): boolean {
    return !!this.link;
  }
  /** Whether the layer will present this window (so callers should not show it). */
  get onDesktop(): boolean {
    return this.mode === "desktop" || !!this.o.desktop?.pinned(this.o.pluginId, this.o.profile);
  }
  private topmost(value: boolean): void {
    if (this.o.setTopmost) this.o.setTopmost(value);
    else this.o.window.setAlwaysOnTop(value);
  }
  private present(value: PluginWindowPresentation): void {
    const window = this.o.window;
    if (this.disposed || window.isDestroyed()) return;
    if (!value) {
      const wasDesktop = !!this.presented;
      this.presented = undefined;
      if (this.mode === "desktop") this.mode = "normal";
      window.setSkipTaskbar(!this.o.taskbar());
      window.setFocusable(true);
      window.setIgnoreMouseEvents(false);
      window.setAlwaysOnTop(false);
      if (wasDesktop && this.ordinaryBounds) {
        const area = screen.getDisplayMatching(this.ordinaryBounds).workArea;
        const width = Math.min(this.ordinaryBounds.width, area.width);
        const height = Math.min(this.ordinaryBounds.height, area.height);
        window.setBounds({
          x: Math.max(area.x, Math.min(this.ordinaryBounds.x, area.x + area.width - width)),
          y: Math.max(area.y, Math.min(this.ordinaryBounds.y, area.y + area.height - height)),
          width,
          height,
        });
        if (this.ordinaryMaximized) window.maximize();
      }
      this.o.onChange();
      return;
    }
    if (!this.presented) {
      this.ordinaryBounds = window.getBounds();
      this.ordinaryMaximized = window.isMaximized();
    }
    if (window.isMaximized()) window.unmaximize();
    this.presented = value;
    this.mode = "desktop";
    window.setSkipTaskbar(true);
    window.setFocusable(value.mode === "overlay" || value.card.inputMode === "interactive");
    window.setIgnoreMouseEvents(value.mode === "desktop" && value.card.inputMode === "passive", {
      forward: true,
    });
    window.setAlwaysOnTop(
      value.mode === "overlay" || value.card.group === "top",
      process.platform === "win32" ? "pop-up-menu" : "floating",
    );
    const b = value.card.bounds;
    window.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    });
    if (value.visible) {
      if (!window.isVisible()) window.showInactive();
      if (value.mode === "overlay") window.moveTop();
    } else window.hide();
    this.o.onChange();
  }
  async setMode(next: WindowMode): Promise<void> {
    const window = this.o.window;
    if (this.disposed || window.isDestroyed() || next === this.mode) return;
    if (this.mode === "desktop") await this.link?.unpin();
    if (next === "desktop") {
      if (!this.link) throw new AppError("layer.disabled", "桌面卡片不可用");
      this.topmost(false);
      await this.link.pin(window.getBounds());
      return;
    }
    this.mode = next;
    this.topmost(next === "topmost");
    this.o.onChange();
  }
  /** "Close" on the desktop: leave the desktop and hide; the page stays alive. */
  async removeFromDesktop(): Promise<void> {
    await this.setMode("normal");
    if (!this.o.window.isDestroyed()) this.o.window.hide();
  }
  /** A card the user moved or resized natively reports its new geometry. */
  private report(): void {
    const p = this.presented?.card.bounds;
    if (!p || !this.link || this.o.window.isDestroyed()) return;
    const b = this.o.window.getBounds();
    if (b.x === p.x && b.y === p.y && b.width === p.width && b.height === p.height) return;
    void this.link.bounds(b).catch((error) => console.error("plugin-window-bounds", error));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.link?.dispose();
    this.link = undefined;
  }
}
