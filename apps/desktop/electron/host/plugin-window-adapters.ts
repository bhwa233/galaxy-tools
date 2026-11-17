import { Menu, type BrowserWindow } from "electron";
import { effectiveWindowCapabilities, type WindowBinding } from "@spark233/sdk";
import type { LayerCard } from "../../shared/layer-contract.js";
import type { Rect } from "../../src/features/capsules/types.js";
import type { DesktopLayer } from "../desktop-layer.js";
import type { PluginManager } from "../plugins/manager.js";
import type { ResolvedWindowDefinition } from "./plugin-window-catalog.js";
import type { PluginWindowAdapter } from "./plugin-window-coordinator.js";
import { windowOpenContext } from "./plugin-window-routing.js";
import { PluginWindowLayoutStore, type WindowInstanceRecord } from "./plugin-window-state.js";
import { prepareInstantWindow } from "../window-transitions.js";

interface WindowControl {
  readonly instanceId: string;
  setAlwaysOnTop(value: boolean): void;
  open(environment: "desktop" | "card-desktop"): Promise<void>;
  state(): {
    environment: "desktop" | "card-desktop";
    chrome: "host" | "none";
    capabilities: ReturnType<typeof effectiveWindowCapabilities>;
  };
  close(): Promise<void>;
  collapse(): Promise<void>;
  menu(anchor?: { x: number; y: number }): void;
}
const controls = new WeakMap<BrowserWindow, WindowControl>();
const controlListeners = new WeakMap<BrowserWindow, () => void>();
// Match the card presentation's native level. On Windows a borrowed window
// returned with the default level could retain a false native topmost flag.
const topmostLevel = process.platform === "win32" ? "pop-up-menu" : "floating";
export function onUnifiedWindowState(window: BrowserWindow, listener: () => void): void {
  controlListeners.set(window, listener);
}
/** The owning host window is the identity; pages never supply a target ID. */
export const unifiedWindowControl = (window: BrowserWindow) => controls.get(window);

/** Adapter reuses external-participant presentation rather than reparenting a
 * WebContentsView into the trusted renderer. Saved placements own geometry;
 * the native snapshot exists only while the card desktop borrows the window. */
export class PluginWindowAdapters implements PluginWindowAdapter {
  private windows = new Map<
    string,
    {
      window: BrowserWindow;
      release: () => void;
      applying?: boolean;
      inputBlocked?: boolean;
      placementId?: string;
      reveal?: () => void;
      ordinary?: {
        bounds: Rect;
        visible: boolean;
        topmost: boolean;
        maximized: boolean;
        minimized: boolean;
        taskbar: boolean;
        focusable: boolean;
        resizable: boolean;
        minimizable: boolean;
        maximizable: boolean;
      };
    }
  >();
  private failures = new Map<string, string>();
  constructor(
    private readonly options: {
      store: PluginWindowLayoutStore;
      layer: DesktopLayer;
      manager(): PluginManager | undefined;
      definition(pluginId: string, windowId: string): ResolvedWindowDefinition | undefined;
      icon?(pluginId: string): string | undefined;
      changed?(): void;
      close(placementId: string): Promise<void>;
      open(instance: WindowInstanceRecord, environment: "desktop" | "card-desktop"): Promise<void>;
    },
  ) {
    options.layer.register({
      id: "unified-plugin-windows",
      snapshot: () => this.cards(),
    });
  }
  failure(instanceId: string): string | undefined {
    return this.failures.get(instanceId);
  }
  private cards(): LayerCard[] {
    const state = this.options.store.load();
    const displays = this.options.layer.options.displays();
    const display =
      displays.find((value) => value.id === this.options.layer.options.primaryDisplay()) ??
      displays[0];
    if (!display) return [];
    return state.placements
      .filter((value) => value.environment === "card-desktop")
      .flatMap((placement) => {
        const instance = state.instances.find((value) => value.id === placement.instanceId);
        if (!instance) return [];
        const definition = this.options.definition(instance.pluginId, instance.binding.windowId);
        if (
          (definition?.bridge === "widget" || definition?.bridge === "utools") &&
          !this.failures.has(instance.id) &&
          this.options
            .manager()
            ?.list()
            .some(
              (record) =>
                record.pluginId === instance.pluginId && record.enabled && !record.lastError,
            )
        )
          return [];
        return [
          {
            id: "placement:" + placement.id,
            cardDesktopOnly: true,
            unifiedWindow: true,
            chrome:
              this.failures.has(instance.id) || !this.windows.has(instance.id)
                ? "host"
                : (definition?.chrome ?? "host"),
            cardDesktopMember: true,
            pluginId: instance.pluginId,
            pluginTitle: definition?.pluginTitle ?? instance.pluginId,
            pluginIcon: this.options.icon?.(instance.pluginId),
            title: definition?.title ?? instance.binding.windowId,
            displayId: display.id,
            bounds: {
              ...placement.bounds,
              x: display.workArea.x + placement.bounds.x,
              y: display.workArea.y + placement.bounds.y,
            },
            visible: true,
            order: placement.order,
            group: "normal" as const,
            inputMode: "interactive" as const,
            renderKind: this.windows.has(instance.id)
              ? ("window" as const)
              : ("declarative" as const),
            renderRef: instance.id,
            unavailableReason:
              this.failures.get(instance.id) ??
              (!this.windows.has(instance.id) ? "插件已停用或窗口尚未恢复" : undefined),
            payload: this.failures.has(instance.id)
              ? { error: this.failures.get(instance.id)! }
              : undefined,
          },
        ];
      });
  }
  attach(instanceId: string, window: BrowserWindow): () => void {
    void prepareInstantWindow(window);
    this.windows.get(instanceId)?.release();
    const entry = {
      window,
      release: () => {},
      ordinary: undefined as
        | {
            bounds: Rect;
            visible: boolean;
            topmost: boolean;
            maximized: boolean;
            minimized: boolean;
            taskbar: boolean;
            focusable: boolean;
            resizable: boolean;
            minimizable: boolean;
            maximizable: boolean;
          }
        | undefined,
    };
    this.windows.set(instanceId, entry);
    const currentPlacement = () =>
      this.options.store
        .load()
        .placements.find(
          (value) =>
            value.instanceId === instanceId &&
            value.environment ===
              (this.options.layer.overlayActive &&
              this.options.store
                .load()
                .placements.some(
                  (item) => item.instanceId === instanceId && item.environment === "card-desktop",
                )
                ? "card-desktop"
                : "desktop"),
        );
    const instance = this.options.store.load().instances.find((value) => value.id === instanceId)!;
    const definition = this.options.definition(instance.pluginId, instance.binding.windowId)!;
    const closeCurrent = async () => {
      const placement = currentPlacement();
      if (placement) await this.options.close(placement.id);
    };
    const focus = () => {
      const placement = currentPlacement();
      if (!placement || placement.environment !== "card-desktop") return;
      if (!this.options.layer.noteOverlayFocus("placement:" + placement.id)) return;
      this.options.store.commit((draft) => {
        draft.placements.find((value) => value.id === placement.id)!.order = Date.now();
      });
      this.options.layer.refresh();
    };
    window.on("focus", focus);
    const control: WindowControl = {
      setAlwaysOnTop: (value) => {
        const placement = currentPlacement();
        if (placement?.environment !== "desktop") throw new Error("当前环境不支持置顶");
        this.options.store.commit((draft) => {
          draft.placements.find((item) => item.id === placement.id)!.topmost = value;
        });
        window.setAlwaysOnTop(value, topmostLevel);
        controlListeners.get(window)?.();
      },
      open: (environment) => this.options.open(instance, environment),
      instanceId,
      state: () => {
        const environment =
          this.options.layer.overlayActive &&
          this.options.store
            .load()
            .placements.some(
              (value) => value.instanceId === instanceId && value.environment === "card-desktop",
            )
            ? ("card-desktop" as const)
            : ("desktop" as const);
        return {
          environment,
          chrome: definition.chrome,
          capabilities: effectiveWindowCapabilities(definition, environment),
        };
      },
      close: closeCurrent,
      collapse: () => this.options.layer.closeOverlay(),
      menu: (anchor) => {
        const state = control.state();
        const english = this.options.layer.options.locale().startsWith("en");
        Menu.buildFromTemplate([
          ...(state.environment === "desktop"
            ? [
                {
                  label: english ? "Always on top" : "置顶",
                  type: "checkbox" as const,
                  checked: window.isAlwaysOnTop(),
                  click: (item: Electron.MenuItem) => {
                    control.setAlwaysOnTop(item.checked);
                  },
                },
              ]
            : []),
          ...(definition.cardDesktop
            ? [
                {
                  label:
                    state.environment === "desktop"
                      ? english
                        ? "Add to card desktop"
                        : "添加到卡片桌面"
                      : english
                        ? "Open independent window"
                        : "独立窗口打开",
                  click: () => {
                    const environment =
                      state.environment === "desktop" ? "card-desktop" : "desktop";
                    void this.options
                      .open(instance, environment)
                      .catch((error) => console.error("window-menu", error));
                  },
                },
              ]
            : []),
          {
            label: english ? "Close" : "关闭",
            click: () => void closeCurrent().catch((error) => console.error("window-menu", error)),
          },
        ]).popup({ window, ...anchor });
      },
    };
    controls.set(window, control);
    this.refreshBindings(instanceId);
    let applying = false;
    const report = () => {
      if (applying || this.windows.get(instanceId)?.applying || window.isDestroyed()) return;
      const state = this.options.store.load();
      const placement = state.placements.find(
        (value) => value.instanceId === instanceId && value.environment === "card-desktop",
      );
      if (!this.options.layer.overlayActive) {
        const desktop = state.placements.find(
          (value) => value.instanceId === instanceId && value.environment === "desktop",
        );
        if (desktop && JSON.stringify(desktop.bounds) !== JSON.stringify(window.getBounds()))
          this.options.store.commit((draft) => {
            draft.placements.find((value) => value.id === desktop.id)!.bounds = window.getBounds();
          });
        return;
      }
      if (!placement) return;
      const projected = this.options.layer.externalPresentation("placement:" + placement.id)?.card
        .bounds;
      if (projected && JSON.stringify(window.getBounds()) === JSON.stringify(projected)) return;
      applying = true;
      void this.options.layer
        .externalBounds("placement:" + placement.id, window.getBounds())
        .catch((error) => console.error("window-card-bounds", error))
        .finally(() => {
          applying = false;
        });
    };
    window.on("moved", report);
    window.on("resized", report);
    const close = (event: Electron.Event) => {
      event.preventDefault();
      void closeCurrent().catch((error) => console.error("window-close", error));
    };
    window.on("close", close);
    return () => {
      if (this.windows.get(instanceId) !== entry) return;
      entry.release();
      controls.delete(window);
      controlListeners.delete(window);
      window.removeListener("moved", report);
      window.removeListener("resized", report);
      window.removeListener("close", close);
      window.removeListener("focus", focus);
      this.windows.delete(instanceId);
      this.options.layer.refresh();
    };
  }
  private refreshBindings(instanceId: string) {
    const entry = this.windows.get(instanceId);
    if (!entry) return;
    const placement = this.options.store
      .load()
      .placements.find(
        (value) => value.instanceId === instanceId && value.environment === "card-desktop",
      );
    if (!placement || entry.placementId === placement.id) return;
    entry.release();
    entry.placementId = placement.id;
    entry.release = this.options.layer.registerExternal("placement:" + placement.id, {
      reveal: () => {
        const show = entry.reveal;
        entry.reveal = undefined;
        show?.();
      },
      focus: () => !entry.window.isDestroyed() && entry.window.isFocused(),
      activate: () => {
        if (entry.inputBlocked || entry.window.isDestroyed() || !entry.window.isVisible()) return;
        entry.window.moveTop();
        entry.window.focus();
      },
      present: async (value) => {
        const window = entry.window;
        await prepareInstantWindow(window);
        if (window.isDestroyed()) return;
        if (value.deferReveal && (value.mode !== "overlay" || entry.ordinary)) window.hide();
        let revealVisible = false;
        entry.applying = true;
        try {
          if (value.mode === "overlay") {
            revealVisible = value.visible;
            const entering = !entry.ordinary;
            if (entering) {
              entry.ordinary = {
                bounds: window.getBounds(),
                visible: window.isVisible(),
                topmost: window.isAlwaysOnTop(),
                maximized: window.isMaximized(),
                minimized: window.isMinimized(),
                taskbar: !(
                  this.options.definition(
                    this.options.store.load().instances.find((item) => item.id === instanceId)!
                      .pluginId,
                    this.options.store.load().instances.find((item) => item.id === instanceId)!
                      .binding.windowId,
                  )?.taskbar ?? true
                ),
                focusable: window.isFocusable(),
                resizable: window.isResizable(),
                minimizable: window.isMinimizable(),
                maximizable: window.isMaximizable(),
              };
              if (value.deferReveal) window.hide();
              // Apply frame/taskbar changes once per handoff, not on each
              // geometry or modal snapshot while this window is borrowed.
              if (window.isMinimized()) window.restore();
              if (window.isMaximized()) window.unmaximize();
              window.setMinimizable(false);
              window.setMaximizable(false);
              window.setSkipTaskbar(true);
              window.setAlwaysOnTop(true, topmostLevel);
            }
            const inputChanged = entering || entry.inputBlocked !== !!value.inputBlocked;
            entry.inputBlocked = !!value.inputBlocked;
            if (inputChanged) {
              window.setFocusable(!entry.inputBlocked);
              window.setIgnoreMouseEvents(entry.inputBlocked);
            }
            const source = value.card.bounds;
            const bounds = {
              x: Math.round(source.x),
              y: Math.round(source.y),
              width: Math.round(source.width),
              height: Math.round(source.height),
            };
            if (JSON.stringify(window.getBounds()) !== JSON.stringify(bounds))
              window.setBounds(bounds);
            if (value.visible && !value.deferReveal) {
              if (!window.isVisible()) window.showInactive();
              if (!entry.inputBlocked) window.moveTop();
            } else window.hide();
          } else {
            entry.inputBlocked = false;
            window.setIgnoreMouseEvents(false);
            const ordinary = entry.ordinary;
            const hasDesktop = this.options.store
              .load()
              .placements.some(
                (item) => item.instanceId === instanceId && item.environment === "desktop",
              );
            if (ordinary) {
              revealVisible = hasDesktop && ordinary.visible && !ordinary.minimized;
              entry.ordinary = undefined;
              window.setSkipTaskbar(ordinary.taskbar);
              window.setFocusable(ordinary.focusable);
              window.setResizable(ordinary.resizable);
              window.setMinimizable(ordinary.minimizable);
              window.setMaximizable(ordinary.maximizable);
              window.setAlwaysOnTop(ordinary.topmost, topmostLevel);
              this.restoreBorrowedBounds(window, ordinary.bounds);
              if (ordinary.maximized) window.maximize();
              if (ordinary.minimized) window.minimize();
              if (hasDesktop && ordinary.visible && !value.deferReveal) {
                if (!window.isVisible()) window.showInactive();
              } else window.hide();
            } else if (!hasDesktop) window.hide();
          }
          window.webContents.send("spark233:event:window-mode-changed", {
            mode:
              value.mode === "overlay" ? "desktop" : window.isAlwaysOnTop() ? "topmost" : "normal",
            desktopAvailable: false,
          });
          controlListeners.get(window)?.();
          entry.reveal = value.deferReveal
            ? () => {
                if (window.isDestroyed()) return;
                if (revealVisible) window.showInactive();
                else window.hide();
              }
            : undefined;
        } finally {
          entry.applying = false;
        }
      },
      restack: () => {
        if (!entry.inputBlocked && !entry.window.isDestroyed() && entry.window.isVisible())
          entry.window.moveTop();
      },
    });
  }
  async create(definition: ResolvedWindowDefinition, creationId: string): Promise<WindowBinding> {
    const manager = this.options.manager();
    if (!manager) throw new Error("Plugin host is unavailable");
    return manager.createWindowContent(definition.pluginId, definition.windowId, creationId);
  }
  async activate(
    instance: WindowInstanceRecord,
    activation: import("@spark233/sdk").PluginActivation,
  ): Promise<void> {
    await this.options.manager()?.activateWindow(instance.pluginId, instance.id, activation);
  }
  async restore(instance: WindowInstanceRecord): Promise<void> {
    try {
      const manager = this.options.manager();
      if (!manager) throw new Error("Plugin host is unavailable");
      // Reopening a live presentation must preserve its search, scroll and undo
      // state. Activation is only the initial binding handshake for a page.
      if (!this.windows.has(instance.id))
        await manager.openWindow(instance.pluginId, instance.id, instance.binding);
      windowOpenContext.getStore()?.assertActive?.();
      this.failures.delete(instance.id);
      this.refreshBindings(instance.id);
      const desktop = this.options.store
        .load()
        .placements.find(
          (value) => value.instanceId === instance.id && value.environment === "desktop",
        );
      const entry = this.windows.get(instance.id);
      if (desktop && entry && !this.options.layer.overlayActive) {
        entry.window.setBounds(desktop.bounds);
        entry.window.setAlwaysOnTop(!!desktop.topmost, topmostLevel);
        if (desktop.visible) {
          entry.window.show();
          entry.window.focus();
        } else entry.window.hide();
      }
      if (entry) {
        const state = unifiedWindowControl(entry.window)?.state();
        entry.window.webContents.send("spark233:event:window-mode-changed", {
          mode:
            state?.environment === "card-desktop"
              ? "desktop"
              : entry.window.isAlwaysOnTop()
                ? "topmost"
                : "normal",
          desktopAvailable: false,
        });
        controlListeners.get(entry.window)?.();
      }
    } catch (error) {
      this.failures.set(instance.id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.options.layer.refresh();
      this.options.changed?.();
    }
  }
  async restoreCards(): Promise<void> {
    const state = this.options.store.load();
    for (const instance of state.instances) {
      if (
        !state.placements.some(
          (value) => value.instanceId === instance.id && value.environment === "card-desktop",
        )
      )
        continue;
      if (this.windows.has(instance.id)) continue;
      const definition = this.options.definition(instance.pluginId, instance.binding.windowId);
      if (!definition?.cardDesktop || definition.bridge === "widget") continue;
      try {
        await windowOpenContext.run(
          { environment: "card-desktop", coordinated: true, instanceId: instance.id },
          () => this.restore(instance),
        );
      } catch (error) {
        console.error("card-window-restore", instance.pluginId, error);
      }
    }
  }
  async prepareClose(instance: WindowInstanceRecord) {
    return (
      (await this.options.manager()?.prepareWindowClose(instance.pluginId, instance.id)) ?? {
        ok: true,
      }
    );
  }
  async restoreDesktop(): Promise<void> {
    const state = this.options.store.load();
    for (const instance of state.instances) {
      const placement = state.placements.find(
        (value) => value.instanceId === instance.id && value.environment === "desktop",
      );
      const definition = this.options.definition(instance.pluginId, instance.binding.windowId);
      if (
        !placement?.visible ||
        this.windows.has(instance.id) ||
        !definition ||
        definition.bridge === "widget" ||
        !(instance.autoRestore ?? definition.restore?.autoOpen ?? false)
      )
        continue;
      try {
        await windowOpenContext.run(
          { environment: "desktop", coordinated: true, instanceId: instance.id },
          () => this.restore(instance),
        );
      } catch (error) {
        console.error("desktop-window-restore", instance.pluginId, error);
      }
    }
  }
  async closePlacement(instance: WindowInstanceRecord) {
    const remaining = this.options.store
      .load()
      .placements.filter((value) => value.instanceId === instance.id);
    const entry = this.windows.get(instance.id);
    if (
      this.options.definition(instance.pluginId, instance.binding.windowId)?.bridge === "utools"
    ) {
      if (!remaining.length)
        await this.options.manager()?.closeWindow(instance.pluginId, instance.id);
      const target =
        remaining.find(
          (value) =>
            value.environment === (this.options.layer.overlayActive ? "card-desktop" : "desktop"),
        ) ?? remaining[0];
      if (target)
        await windowOpenContext.run(
          { environment: target.environment, coordinated: true, instanceId: instance.id },
          () => this.restore(instance),
        );
      this.options.layer.refresh();
      return;
    }
    entry?.release();
    if (entry) {
      entry.release = () => {};
      entry.placementId = undefined;
    }
    if (remaining.some((value) => value.environment === "card-desktop")) {
      this.refreshBindings(instance.id);
      this.options.layer.refresh();
      if (entry && !this.options.layer.overlayActive) entry.window.hide();
      return;
    }
    if (entry && remaining.some((value) => value.environment === "desktop") && entry.ordinary) {
      const ordinary = entry.ordinary;
      entry.ordinary = undefined;
      entry.inputBlocked = false;
      entry.window.setIgnoreMouseEvents(false);
      entry.window.setAlwaysOnTop(ordinary.topmost, topmostLevel);
      entry.window.setMinimizable(ordinary.minimizable);
      entry.window.setMaximizable(ordinary.maximizable);
      entry.window.setSkipTaskbar(ordinary.taskbar);
      entry.window.setFocusable(ordinary.focusable);
      entry.window.setResizable(ordinary.resizable);
      this.restoreBorrowedBounds(entry.window, ordinary.bounds);
      if (ordinary.maximized) entry.window.maximize();
      if (ordinary.minimized) entry.window.minimize();
      if (ordinary.visible) entry.window.showInactive();
      else entry.window.hide();
    }
    if (!remaining.length)
      await this.options.manager()?.closeWindow(instance.pluginId, instance.id);
    this.options.layer.refresh();
  }

  private restoreBorrowedBounds(window: BrowserWindow, bounds: Rect): void {
    // Electron's Windows DIP rounding can enlarge a native snapshot on restore
    // (electron/electron#51572). getNormalBounds and the content-size APIs also
    // drift, and the existing layer geometry helpers only cache requested rects.
    // Correct only this small native readback error; retain OS size constraints
    // and avoid adding a Windows native dependency for snapshot restoration.
    let requested = { ...bounds };
    let closest = requested;
    let smallestError = Infinity;
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const key = JSON.stringify(requested);
      if (tried.has(key)) break;
      tried.add(key);
      window.setBounds(requested);
      if (process.platform !== "win32") return;
      const actual = window.getBounds();
      const difference = {
        x: bounds.x - actual.x,
        y: bounds.y - actual.y,
        width: bounds.width - actual.width,
        height: bounds.height - actual.height,
      };
      const deltas = Object.values(difference);
      const error = deltas.reduce((sum, value) => sum + Math.abs(value), 0);
      if (!error || deltas.some((value) => Math.abs(value) > 3)) return;
      if (error < smallestError) {
        closest = requested;
        smallestError = error;
      }
      requested = {
        x: requested.x + Math.sign(difference.x),
        y: requested.y + Math.sign(difference.y),
        width: Math.max(1, requested.width + Math.sign(difference.width)),
        height: Math.max(1, requested.height + Math.sign(difference.height)),
      };
    }
    // Some physical pixel sizes have no exact integer DIP representation.
    window.setBounds(closest);
  }
}
