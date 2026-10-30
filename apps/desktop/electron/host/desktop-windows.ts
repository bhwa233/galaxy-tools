import { BrowserWindow, nativeTheme, screen } from "electron";
import type { PluginManifest } from "@spark233/sdk";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { shouldHideLauncher } from "../host/launcher-presentation.js";
import { createHostWindow } from "../host/windows.js";
import { AppError, confined, readJson } from "../persistence.js";
import type { PluginResourceScope } from "../plugins/resources.js";
import type { Layout, RuntimeContext } from "../runtime.js";
import { pluginPresentation } from "../plugins/presentation.js";
import type { PluginWindowActivation, PluginWindowInfo } from "../../shared/plugin-windows.js";
import { PluginWindowActivations } from "./plugin-window-activations.js";
import { PluginWindowStateStore } from "./plugin-window-state.js";

/** desktop-windows owns this domain; shared state remains in the composition root. */
export function createDesktopWindows(
  ctx: Pick<
    RuntimeContext,
    | "windows"
    | "layouts"
    | "applyNoteTopmost"
    | "scheduleLayout"
    | "launcherPresentationGuard"
    | "windowPresentations"
    | "ready"
    | "here"
    | "configDir"
    | "officialRenderers"
    | "officialWindows"
    | "launcherComposition"
    | "nativeDialogDepth"
    | "revokeLauncherCaller"
    | "crashedWindows"
    | "notesScope"
    | "pluginHost"
    | "hostShortcuts"
    | "emit"
    | "paperMenu"
    | "reportError"
    | "publishNoteStates"
    | "launcherCallers"
    | "launcherHides"
    | "launcherExecutions"
    | "launcher"
    | "launcherDialogs"
    | "hideHostWindow"
    | "cancelSelection"
    | "exiting"
    | "hostConfig"
    | "quit"
    | "hideAndRelease"
    | "foldAndRelease"
    | "pendingManagerOpen"
    | "preparedWindows"
    | "workspaceRequests"
    | "devUrl"
    | "maintenance"
    | "hostShutdown"
    | "notesActive"
    | "prepare"
    | "ui"
  >,
) {
  let hostDeclarations:
    | Record<
        string,
        {
          title: Record<string, string>;
          icon: NonNullable<NonNullable<PluginManifest["ui"]>["icon"]>;
        }
      >
    | undefined;
  function nativeIconTheme() {
    return {
      accent: ctx.hostConfig.value.accentColor ?? "green",
      effective: nativeTheme.shouldUseDarkColors ? ("dark" as const) : ("light" as const),
    };
  }
  function hostPresentation(layout: { hostPage?: string }) {
    if (!layout.hostPage) return undefined;
    const root = path.join(ctx.here, "assets");
    const file = path.join(root, "host-windows.json");
    if (!hostDeclarations && fs.existsSync(file)) hostDeclarations = readJson(file);
    const entry = hostDeclarations?.[layout.hostPage];
    const theme = nativeIconTheme();
    const resource = entry?.icon.themes?.[theme.accent]?.[theme.effective] ?? entry?.icon;
    return entry
      ? {
          title: entry.title[ctx.hostConfig.value.locale.startsWith("en") ? "en-US" : "zh-CN"],
          image: confined(root, resource!.png),
          shellIcon: confined(root, resource!.ico ?? resource!.png),
        }
      : undefined;
  }
  function getHostIcon(page: string): string | undefined {
    return hostPresentation({ hostPage: page })?.image;
  }
  let windowStates: PluginWindowStateStore | undefined;
  function pluginWindowStates() {
    if (!windowStates) {
      windowStates = new PluginWindowStateStore(
        path.join(ctx.configDir, "host", "plugin-windows.json"),
      );
      if (windowStates.readError)
        console.error("plugin-window-state-unreadable", windowStates.readError);
    }
    return windowStates;
  }
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  function flushPluginWindowStates(): void {
    if (stateTimer) clearTimeout(stateTimer);
    windowStates?.flush();
  }
  const activations = new PluginWindowActivations();
  function windowPresentation(layout: Layout) {
    const pluginId =
      layout.pluginId ?? (layout.view !== "launcher" ? ctx.notesScope?.owner.pluginId : undefined);
    if (!pluginId || !ctx.pluginHost) return undefined;
    const presentation = pluginPresentation(
      ctx.pluginHost.manager,
      pluginId,
      ctx.hostConfig.value.locale,
    );
    const profiles = presentation.manifest.ui?.windows ?? {};
    const profile =
      layout.windowProfile ??
      Object.entries(profiles).find(
        ([, window]) =>
          window.legacyLabels?.includes(layout.label) ||
          window.legacyLabels?.includes(layout.workspace ?? "") ||
          (layout.compact && window.presentation === "compact"),
      )?.[0] ??
      (layout.view !== "launcher" ? layout.view : Object.keys(profiles)[0]);
    if (profile && Object.hasOwn(profiles, profile)) layout.windowProfile = profile;
    return pluginPresentation(
      ctx.pluginHost.manager,
      pluginId,
      ctx.hostConfig.value.locale,
      profile,
      nativeIconTheme(),
    );
  }
  function applyWindowPresentation(win: BrowserWindow, layout: Layout) {
    const presentation = windowPresentation(layout);
    const host = hostPresentation(layout);
    win.setTitle(presentation?.title ?? host?.title ?? "spark233");
    if (presentation?.image) win.setIcon(presentation.image);
    else if (host?.image) win.setIcon(host.image);
    if (process.platform === "win32" && presentation)
      win.setAppDetails({
        appId: `com.spark233.desktop.${presentation.manifest.id}`,
        ...(presentation.shellIcon ? { appIconPath: presentation.shellIcon, appIconIndex: 0 } : {}),
      });
    else if (process.platform === "win32" && host)
      win.setAppDetails({
        appId:
          layout.hostPage === "launcher"
            ? "com.spark233.desktop"
            : `com.spark233.desktop.host.${layout.hostPage}`,
        appIconPath: host.shellIcon,
        appIconIndex: 0,
      });
  }
  function refreshWindowPresentations(): void {
    for (const [label, win] of ctx.windows) {
      const layout = ctx.layouts.get(label);
      if (layout && !win.isDestroyed())
        try {
          applyWindowPresentation(win, layout);
        } catch (error) {
          ctx.reportError(error, win);
        }
    }
  }
  function getPluginIcon(pluginId: string): string | undefined {
    if (!ctx.pluginHost) return;
    try {
      return pluginPresentation(ctx.pluginHost.manager, pluginId, ctx.hostConfig.value.locale)
        .iconData;
    } catch {
      return;
    }
  }
  function queuePluginWindowActivation(win: BrowserWindow, payload: unknown): void {
    const owner = ctx.officialWindows.get(win.id) ?? ctx.notesScope?.owner;
    if (!owner) throw new AppError("pluginDisabled", "Plugin window owner is unavailable");
    const activation = activations.enqueue(win.id, owner, payload);
    ctx.emit("plugin-window-activation", activation, win);
  }
  function takePluginWindowActivation(win: BrowserWindow): PluginWindowActivation | undefined {
    const owner = ctx.officialWindows.get(win.id) ?? ctx.notesScope?.owner;
    return owner ? activations.take(win.id, owner) : undefined;
  }
  function pluginWindowInfo(win: BrowserWindow): PluginWindowInfo {
    const layout = ctx.layouts.get(labelOf(win));
    if (!layout) throw new AppError("permissionDenied", "Window is not registered");
    const presentation = windowPresentation(layout);
    if (!presentation) throw new AppError("permissionDenied", "Window does not belong to a plugin");
    return {
      pluginId: presentation.manifest.id,
      profile: layout.windowProfile ?? "main",
      title: presentation.title,
      icon: presentation.iconData,
      presentation: presentation.window?.presentation ?? "standard",
      maximizable: presentation.window?.maximizable ?? true,
      commands: ctx
        .pluginHost!.manager.commands(true)
        .map(({ pluginId, command }) => `${pluginId}:${command.id}`),
    };
  }
  async function openPluginWindow(
    pluginId: string,
    profile: string,
    payload?: unknown,
    placement?: "cursor" | "edge",
  ): Promise<BrowserWindow> {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("hostStopping", "Host is not available");
    const renderer = ctx.officialRenderers.get(pluginId);
    if (!ctx.pluginHost || !renderer || renderer.scope.state !== "active")
      throw new AppError("pluginDisabled", "Plugin renderer is unavailable");
    const presentation = pluginPresentation(
      ctx.pluginHost.manager,
      pluginId,
      ctx.hostConfig.value.locale,
      profile,
    );
    if (!presentation.window)
      throw new AppError("invalidPlugin", "Plugin window profile is not declared");
    const declaration = presentation.window;
    const previous =
      declaration.reuse === "document"
        ? undefined
        : [...ctx.layouts.values()].find(
            (layout) =>
              layout.pluginId === pluginId &&
              (layout.windowProfile === profile ||
                declaration.legacyLabels?.includes(layout.label)),
          );
    const saved = pluginWindowStates().get(pluginId, profile);
    const layout: Layout = previous ?? {
      label: `plugin:${pluginId}:${profile}${declaration.reuse === "document" ? `:${randomUUID()}` : ""}`,
      view: "launcher",
      pluginId,
      windowProfile: profile,
      bounds: safeBounds(saved?.bounds ?? declaration.size ?? { width: 1040, height: 700 }),
      visible: true,
      topmost: false,
      compact: declaration.presentation === "compact",
    };
    layout.windowProfile = profile;
    layout.visible = true;
    if (saved && !previous) layout.topmost = saved.topmost;
    if (placement) {
      const point = screen.getCursorScreenPoint(),
        area = screen.getDisplayNearestPoint(point).workArea;
      layout.bounds = safeBounds({
        ...layout.bounds,
        x: placement === "edge" ? area.x + area.width - layout.bounds.width : point.x,
        y: point.y,
      });
    }
    const execution = ctx.launcherExecutions.getStore();
    if (execution?.active && execution.query)
      ctx.launcher.clear(
        execution.callerId,
        execution.query.sessionId,
        execution.query.requestId,
        "execution",
      );
    const win = createWindow(layout);
    if (payload !== undefined) queuePluginWindowActivation(win, payload);
    return win;
  }
  function labelOf(win: BrowserWindow): string {
    return [...ctx.windows].find(([, value]) => value === win)?.[0] ?? "";
  }

  function remember(win: BrowserWindow): void {
    const layout = ctx.layouts.get(labelOf(win));
    if (!layout || win.isDestroyed()) return;
    layout.bounds = layout.pluginId ? win.getNormalBounds() : win.getBounds();
    if (layout.pluginId && layout.windowProfile) {
      pluginWindowStates().remember({
        pluginId: layout.pluginId,
        profile: layout.windowProfile,
        bounds: layout.bounds,
        topmost: layout.topmost,
      });
      if (stateTimer) clearTimeout(stateTimer);
      stateTimer = setTimeout(() => {
        try {
          flushPluginWindowStates();
        } catch (error) {
          console.error("plugin-window-state-save", error);
        }
      }, 200);
    }
    if (layout.hostPage === "settings") return;
    ctx.applyNoteTopmost(win, layout);
    ctx.scheduleLayout();
  }

  function safeBounds(bounds: Partial<Electron.Rectangle> = {}, main = false): Electron.Rectangle {
    const fallback = { width: main ? 1180 : 360, height: main ? 760 : 420 };
    const point = screen.getCursorScreenPoint();
    const display =
      Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
        ? screen.getDisplayNearestPoint({ x: bounds.x!, y: bounds.y! })
        : screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const width = Math.min(
      area.width,
      Math.max(main ? 900 : 160, Number(bounds.width) || fallback.width),
    );
    const height = Math.min(
      area.height,
      Math.max(main ? 620 : 60, Number(bounds.height) || fallback.height),
    );
    return {
      x: Math.round(
        Math.max(area.x, Math.min(area.x + area.width - width, bounds.x ?? point.x - width / 2)),
      ),
      y: Math.round(
        Math.max(area.y, Math.min(area.y + area.height - height, bounds.y ?? point.y - 24)),
      ),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  function isHostView(layout: Layout): boolean {
    return layout.view === "main" || layout.view === "launcher";
  }

  function isAdminView(layout: Layout): boolean {
    return layout.view === "launcher" && !layout.pluginId;
  }

  function createWindow(layout: Layout): BrowserWindow {
    const presentation = ctx.launcherPresentationGuard();
    if (!presentation()) throw new AppError("cancelled", "面板操作已失效");
    const existing = ctx.windows.get(layout.label);
    if (existing && !existing.isDestroyed()) {
      applyWindowPresentation(existing, layout);
      ctx.windowPresentations.set(existing, presentation);
      layout.visible = true;
      // Repeated shortcut events can reuse a window before its renderer is ready.
      // Keep the initial presentation in desktop_ready to avoid a blank first show.
      if (ctx.ready.has(existing.id)) {
        if (!existing.isVisible()) existing.show();
        if (!existing.isFocused()) existing.focus();
      }
      return existing;
    }
    layout.bounds = safeBounds(layout.bounds, layout.view === "main");
    ctx.layouts.set(layout.label, layout);
    if (!isHostView(layout)) layout.everOpened = true;
    const area = screen.getDisplayMatching(layout.bounds).workArea;
    const presentationConfig = windowPresentation(layout);
    const hostConfig = hostPresentation(layout);
    const win = createHostWindow({
      bounds: layout.bounds,
      title: presentationConfig?.title ?? hostConfig?.title ?? "spark233",
      preload: path.join(ctx.here, "preload.cjs"),
      icon:
        presentationConfig?.image ?? hostConfig?.image ?? path.join(ctx.here, "assets/icon.ico"),
      resizable: presentationConfig?.window?.resizable,
      maximizable: presentationConfig?.window?.maximizable,
      minWidth: presentationConfig?.window?.minSize
        ? Math.min(presentationConfig.window.minSize.width, area.width)
        : layout.hostPage === "settings"
          ? Math.min(800, area.width)
          : layout.compact
            ? 320
            : layout.view === "launcher"
              ? 640
              : layout.view === "main"
                ? 900
                : 160,
      minHeight: presentationConfig?.window?.minSize
        ? Math.min(presentationConfig.window.minSize.height, area.height)
        : layout.hostPage === "settings"
          ? Math.min(600, area.height)
          : layout.compact
            ? 240
            : layout.view === "launcher"
              ? 420
              : layout.view === "main"
                ? 620
                : 60,
      skipTaskbar:
        layout.label === "launcher" ||
        (presentationConfig?.window?.taskbar !== undefined
          ? !presentationConfig.window.taskbar
          : !isHostView(layout)),
      alwaysOnTop: layout.topmost,
      hasShadow: isHostView(layout),
      label: layout.label,
    });
    applyWindowPresentation(win, layout);
    if (layout.pluginId) {
      const renderer = ctx.officialRenderers.get(layout.pluginId);
      if (!renderer || renderer.scope.state !== "active") {
        win.destroy();
        throw new Error("Plugin renderer is not available");
      }
      ctx.officialWindows.set(win.id, { ...renderer.scope.owner });
    }
    ctx.windows.set(layout.label, win);
    ctx.windowPresentations.set(win, presentation);
    const launcherContentsId = win.webContents.id;
    let initialNavigation = true;
    win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      const first = initialNavigation;
      initialNavigation = false;
      // The first load belongs to the capture-to-window handoff already in flight.
      if (layout.label === "launcher" && first) return;
      ctx.ready.delete(win.id);
      ctx.launcherComposition.delete(win.id);
      ctx.nativeDialogDepth.delete(win.id);
      ctx.revokeLauncherCaller(launcherContentsId);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      ctx.revokeLauncherCaller(launcherContentsId);
      ctx.crashedWindows.add(win.id);
      ctx.ready.delete(win.id);
      const owner =
        ctx.officialWindows.get(win.id) ??
        (layout.view !== "launcher" ? ctx.notesScope?.owner : undefined);
      const error = new Error(
        `Plugin renderer exited: ${details.reason} (${details.exitCode}); last saved data was retained`,
      );
      if (owner) void ctx.pluginHost?.manager.reportCrash(owner, error).catch(console.error);
      else console.error("host-renderer-crash", error);
    });
    ctx.applyNoteTopmost(win, layout);
    win.webContents.on("before-input-event", (_event, input) => {
      if (
        !ctx.hostShortcuts.isRecording ||
        input.type !== "keyDown" ||
        ["Control", "Alt", "Shift", "Meta"].includes(input.key)
      )
        return;
      ctx.emit(
        "shortcut-hook-key",
        {
          key: input.key === " " ? "Space" : input.key,
          ctrl: input.control,
          alt: input.alt,
          shift: input.shift,
          meta: input.meta,
        },
        win,
      );
    });
    win.on("system-context-menu", (event) => {
      if (!isHostView(layout)) {
        event.preventDefault();
        void ctx
          .paperMenu(win)
          .then((menu) => {
            if (!win.isDestroyed()) menu.popup({ window: win });
          })
          .catch((error) => ctx.reportError(error, win));
      }
    });
    win.on("move", () => remember(win));
    win.on("resize", () => {
      remember(win);
      ctx.emit("window-resized", null, win);
    });
    win.on("show", () => {
      layout.visible = true;
      if (layout.label === "launcher") {
        ctx.preparedWindows.delete(win.id);
        ctx.emit("launcher-visibility-changed", { visible: true }, win);
      }
      ctx.applyNoteTopmost(win, layout);
      if (layout.hostPage !== "settings") ctx.scheduleLayout();
      ctx.publishNoteStates();
    });
    win.on("hide", () => {
      const caller = ctx.launcherCallers.get(launcherContentsId);
      if (layout.label === "launcher") {
        layout.visible = false;
        ctx.emit("launcher-visibility-changed", { visible: false }, win);
        ctx.workspaceRequests.delete("launcher");
        ctx.cancelSelection();
      }
      const handoff = ctx.launcherHides.get(launcherContentsId);
      ctx.launcherHides.delete(launcherContentsId);
      if (caller) {
        const execution = ctx.launcherExecutions.getStore();
        if (handoff?.caller === caller)
          ctx.launcher.clear(caller, handoff.sessionId, handoff.requestId, "execution");
        else if (execution?.active && execution.callerId === caller && execution.query)
          ctx.launcher.clear(
            caller,
            execution.query.sessionId,
            execution.query.requestId,
            "execution",
          );
        else ctx.launcher.clear(caller);
      }
      ctx.publishNoteStates();
    });
    win.on("blur", () => {
      if (layout.label === "launcher") {
        setTimeout(() => {
          if (
            !win.isDestroyed() &&
            !win.webContents.isDevToolsOpened() &&
            shouldHideLauncher({
              label: layout.label,
              visible: win.isVisible(),
              focused: win.isFocused(),
              ownedDialog: ctx.launcherDialogs.has(win.id) || ctx.nativeDialogDepth.has(win.id),
              composingUntil: ctx.launcherComposition.get(win.id) ?? 0,
              devToolsFocused: win.webContents.isDevToolsFocused(),
            })
          ) {
            ctx.hideHostWindow(win);
          }
        }, 160);
      }
    });
    win.on("close", (event) => {
      if (ctx.exiting) return;
      event.preventDefault();
      if (
        layout.label !== "launcher" &&
        isHostView(layout) &&
        layout.hostPage !== "settings" &&
        !layout.workspace &&
        !layout.pluginId &&
        !layout.compact &&
        !ctx.hostConfig.value.closeToTray
      )
        void ctx.quit();
      else
        void (isHostView(layout) ? ctx.hideAndRelease(win) : ctx.foldAndRelease(win)).catch(
          (error) => ctx.reportError(error, win),
        );
    });
    win.on("query-session-end", (event) => {
      if (ctx.exiting) return;
      // Windows can otherwise terminate the renderer before its asynchronous
      // durable-save handshake. Veto this attempt and close through the coordinator.
      event.preventDefault();
      void ctx.quit();
    });
    win.on("closed", () => {
      try {
        flushPluginWindowStates();
      } catch (error) {
        console.error("plugin-window-state-save", error);
      }
      activations.revoke(win.id);
      ctx.revokeLauncherCaller(launcherContentsId);
      if (ctx.pendingManagerOpen?.windowId === win.id) ctx.pendingManagerOpen = undefined;
      ctx.ready.delete(win.id);
      ctx.crashedWindows.delete(win.id);
      ctx.preparedWindows.delete(win.id);
      ctx.officialWindows.delete(win.id);
      if (ctx.windows.get(layout.label) === win) {
        ctx.workspaceRequests.delete(layout.label);
        ctx.windows.delete(layout.label);
      }
      ctx.publishNoteStates();
    });
    const params = new URLSearchParams({
      view: layout.hostPage ?? layout.view,
      ...(layout.windowProfile ? { window: layout.windowProfile } : {}),
      ...(layout.label === "launcher" && !layout.visible ? { preload: "1" } : {}),
      ...layout.settingsTarget,
      ...(layout.noteId ? { noteId: layout.noteId } : {}),
      ...(layout.workspace ? { workspace: layout.workspace } : {}),
      ...(layout.compact ? { compact: "1" } : {}),
    });
    // Development serves every window, workspace included, from the Vite dev
    // server so renderer edits hot-update in place. Production keeps loading
    // the plugin package's own renderer, which is the shipped artifact.
    const url = ctx.devUrl
      ? presentationConfig?.window
        ? `${ctx.devUrl}/@fs/${presentationConfig.root.split(path.sep).join("/")}/${presentationConfig.window.entry}`
        : ctx.devUrl
      : layout.pluginId
        ? `spark233://workspace/${encodeURIComponent(layout.pluginId)}/${presentationConfig?.entry ?? "index.html"}`
        : layout.view === "launcher"
          ? "spark233://app/index.html"
          : "spark233://notes/index.html";
    void win.loadURL(`${url}?${params}`).catch((error) => ctx.reportError(error));
    return win;
  }

  function requireNotes(): void {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
    if (!ctx.notesActive) throw new AppError("pluginDisabled", "便签插件已停用，请从插件管理启用");
  }

  function bindOfficialRenderer(
    pluginId: string,
    directory: string,
    scope: PluginResourceScope,
  ): void {
    const renderer = confined(directory, "renderer");
    if (!fs.statSync(confined(renderer, "index.html")).isFile())
      throw new Error(`Plugin renderer is missing: ${pluginId}`);
    ctx.officialRenderers.set(pluginId, { directory: renderer, scope });
    scope.own("window", {
      prepareStop: async () => {
        const saved = await Promise.all(
          [...ctx.windows.values()]
            .filter((win) => ctx.officialWindows.get(win.id)?.instanceId === scope.owner.instanceId)
            .map(ctx.prepare),
        );
        return saved.every(Boolean)
          ? { ok: true }
          : {
              ok: false,
              reason: ctx.ui("插件工作区尚未保存", "The plugin workspace has not finished saving"),
            };
      },
      dispose: () => {
        for (const win of ctx.windows.values())
          if (ctx.officialWindows.get(win.id)?.instanceId === scope.owner.instanceId) win.destroy();
        if (ctx.officialRenderers.get(pluginId)?.scope.owner.instanceId === scope.owner.instanceId)
          ctx.officialRenderers.delete(pluginId);
      },
    });
  }

  async function openHostSettings(target: NonNullable<Layout["settingsTarget"]>): Promise<boolean> {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting) return false;
    if (target.pluginId) ctx.pluginHost?.manager.describe(target.pluginId);
    const previous = ctx.windows.get("settings");
    if (previous && ctx.ready.has(previous.id) && !(await ctx.prepare(previous))) return false;
    const existingLayout = ctx.layouts.get("settings");
    const bounds =
      existingLayout?.bounds ??
      (() => {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const width = Math.min(1080, area.width),
          height = Math.min(760, area.height);
        return {
          x: Math.round(area.x + (area.width - width) / 2),
          y: Math.round(area.y + (area.height - height) / 2),
          width,
          height,
        };
      })();
    const settingsLayout: Layout = {
      label: "settings",
      view: "launcher",
      hostPage: "settings",
      settingsTarget: target,
      bounds,
      visible: true,
      topmost: false,
    };
    const settings = createWindow(settingsLayout);
    const current = ctx.layouts.get("settings")!;
    current.settingsTarget = target;
    if (settings.isMinimized()) settings.restore();
    if (ctx.ready.has(settings.id)) ctx.emit("settings-navigate", target, settings);
    return true;
  }
  return {
    flushPluginWindowStates,
    refreshWindowPresentations,
    getPluginIcon,
    getHostIcon,
    queuePluginWindowActivation,
    takePluginWindowActivation,
    pluginWindowInfo,
    openPluginWindow,
    labelOf,
    remember,
    safeBounds,
    isHostView,
    isAdminView,
    createWindow,
    requireNotes,
    bindOfficialRenderer,
    openHostSettings,
  };
}
