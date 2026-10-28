import { commandMatchesSourceApplication, localizePluginManifest } from "@spark233/sdk";
import { BrowserWindow, screen } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NativeSelectionReader } from "../selection-native.js";
import { SelectionLauncher } from "../selection-launcher.js";
import { AppError } from "../persistence.js";
import type { Layout, RuntimeContext } from "../runtime.js";

/** launcher-runtime owns this domain; shared state remains in the composition root. */
export function createLauncherRuntime(
  ctx: Pick<
    RuntimeContext,
    | "launcherExecutions"
    | "launcher"
    | "launcherCallers"
    | "windows"
    | "launcherHides"
    | "backupSelections"
    | "applicationEntries"
    | "pluginHost"
    | "diagnosticSubscriptions"
    | "emit"
    | "launcherShow"
    | "maintenance"
    | "hostShutdown"
    | "releasing"
    | "clipboardRuntime"
    | "capsules"
    | "layouts"
    | "safeBounds"
    | "createWindow"
    | "ready"
    | "reportError"
    | "hostConfig"
    | "workspaceRequests"
    | "labelOf"
    | "ui"
    | "officialRenderers"
    | "clearLauncherContext"
    | "here"
    | "configDir"
  >,
) {
  let reader: NativeSelectionReader | undefined;
  const selectionLauncher = new SelectionLauncher({
    read: (signal) => getReader().read(signal),
    present: async (text, revision, signal) => {
      await prepareLauncher();
      if (signal.aborted) return;
      if (ctx.maintenance || ctx.hostShutdown.isQuitting) return;
      ctx.clearLauncherContext();
      const win = ctx.launcherExecutions.exit(() => openLauncherWindow());
      const payload = { kind: "launcher-input", result: { text, revision } };
      ctx.workspaceRequests.set("launcher", payload);
      if (ctx.ready.has(win.id)) ctx.emit("open-workspace", payload, win);
    },
  });
  function getReader(): NativeSelectionReader {
    return (reader ??= new NativeSelectionReader({
      assetDirectory: path.join(ctx.here, "assets"),
      cacheDirectory: path.join(ctx.configDir, "cache", "selection-native"),
    }));
  }
  function prepareSelectionReader(): void {
    if (process.platform === "win32")
      void getReader()
        .prepare()
        .catch(() => {});
  }
  function cancelSelection(): void {
    selectionLauncher.cancel();
  }
  async function stopSelectionReader(): Promise<void> {
    selectionLauncher.stop();
    await reader?.stop();
  }
  function showLauncherWithSelection(): Promise<void> {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting) return Promise.resolve();
    return selectionLauncher.open();
  }
  function launcherPresentationGuard(): () => boolean {
    return () => true;
  }

  function endLauncherExecutionQuery(): void {
    const execution = ctx.launcherExecutions.getStore();
    if (execution?.active && execution.query)
      ctx.launcher.clear(
        execution.callerId,
        execution.query.sessionId,
        execution.query.requestId,
        "execution",
      );
  }

  function launcherCaller(win: BrowserWindow): string {
    const id = win.webContents.id;
    let caller = ctx.launcherCallers.get(id);
    if (!caller) {
      caller = `${id}:${randomUUID()}`;
      ctx.launcherCallers.set(id, caller);
    }
    return caller;
  }

  function hideHostWindow(win: BrowserWindow): void {
    const id = win.webContents.id;
    const caller = ctx.launcherCallers.get(id);
    const execution = ctx.launcherExecutions.getStore();
    if (
      win.isVisible() &&
      caller &&
      execution?.active &&
      execution.callerId === caller &&
      execution.query
    )
      ctx.launcherHides.set(id, { caller, ...execution.query });
    else ctx.launcherHides.delete(id);
    win.hide();
  }

  function revokeLauncherCaller(id: number): void {
    const caller = ctx.launcherCallers.get(id);
    if (caller) ctx.backupSelections.revokeCaller(caller);
    if (caller) ctx.launcher?.clear(caller);
    if (caller) ctx.applicationEntries.revoke(caller);
    if (caller) ctx.pluginHost?.releaseCaller(caller);
    if (caller) {
      ctx.diagnosticSubscriptions.get(caller)?.();
      ctx.diagnosticSubscriptions.delete(caller);
    }
    ctx.launcherCallers.delete(id);
    ctx.launcherHides.delete(id);
  }

  function deliverLauncherQueryUpdate(
    caller: string,
    result: import("../../src/features/launcher/types.js").LauncherQueryResult,
  ): void {
    for (const win of ctx.windows.values())
      if (
        !win.isDestroyed() &&
        !win.webContents.isDestroyed() &&
        ctx.launcherCallers.get(win.webContents.id) === caller
      )
        ctx.emit("launcher-query-updated", result, win);
  }

  function showLauncher(): Promise<BrowserWindow> {
    cancelSelection();
    if (ctx.workspaceRequests.get("launcher")?.kind === "launcher-input")
      ctx.workspaceRequests.delete("launcher");
    return (ctx.launcherShow ??= presentLauncher().finally(() => {
      ctx.launcherShow = undefined;
    }));
  }

  async function presentLauncher(): Promise<BrowserWindow> {
    await prepareLauncher();
    return openLauncherWindow();
  }

  async function prepareLauncher(): Promise<void> {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
    const closing = ctx.windows.get("launcher");
    if (closing) await ctx.releasing.get(closing.id);
    if (
      ctx.clipboardRuntime &&
      ![
        ...ctx.windows.values(),
        ...[...(ctx.capsules?.surfaces.values() ?? [])].map((surface) => surface.win),
      ].some((win) => win.isFocused())
    ) {
      try {
        await ctx.clipboardRuntime.rememberTarget();
      } catch (error) {
        console.error("clipboard-target", error);
      }
    }
  }

  // Both normal opening and selection handoff use the same launcher window.
  function openLauncherWindow(): BrowserWindow {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
    const layout: Layout = ctx.layouts.get("launcher") ?? {
      label: "launcher",
      view: "launcher",
      bounds: ctx.safeBounds({ width: 760, height: 560 }),
      visible: true,
      topmost: false,
    };
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const { width, height } = ctx.safeBounds({
      width: layout.bounds.width,
      height: layout.bounds.height,
    });
    layout.bounds = {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 3),
      width,
      height,
    };
    const existing = ctx.windows.get("launcher");
    const wasVisible = existing && !existing.isDestroyed() && existing.isVisible();
    if (existing && !existing.isDestroyed()) {
      const previous = existing.getBounds();
      if (
        previous.x !== layout.bounds.x ||
        previous.y !== layout.bounds.y ||
        previous.width !== layout.bounds.width ||
        previous.height !== layout.bounds.height
      )
        existing.setBounds(layout.bounds);
    }
    layout.visible = true;
    const win = ctx.createWindow(layout);
    if (!wasVisible && ctx.ready.has(win.id)) ctx.emit("launcher-shown", undefined, win);
    return win;
  }

  function requestLauncher(): void {
    void showLauncher().catch((error) => ctx.reportError(error));
  }

  async function activateHostCommand(pluginId: string, commandId: string): Promise<unknown> {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("maintenance", "宿主当前正在保存或恢复");
    const manager = ctx.pluginHost?.manager;
    const entry = manager
      ?.commands()
      .find((item) => item.pluginId === pluginId && item.command.id === commandId);
    if (!manager || !entry) throw new AppError("pluginDisabled", "插件操作当前不可用");
    if (!entry.command.mode) return manager.activate(pluginId, { commandId });
    if (!commandMatchesSourceApplication(entry.command))
      throw new AppError("pluginSourceUnavailable", "此操作需要来源程序上下文");
    const metadata = manager.describe(pluginId);
    const title = localizePluginManifest(
      metadata.spark233,
      ctx.hostConfig.value.locale,
    ).commands.find((command) => command.id === commandId)!.title;
    const win = await showLauncher();
    manager.assertCommandAvailable(pluginId, commandId);
    const payload = {
      kind: "launcher-mode",
      result: {
        pluginId,
        commandId,
        version: metadata.version,
        key: pluginId + ":" + entry.command.mode,
        title,
      },
    };
    ctx.workspaceRequests.set(ctx.labelOf(win), payload);
    ctx.emit("open-workspace", payload, win);
  }

  async function showOfficialWorkspace(
    kind: "translation" | "ocr" | "screenshot-history",
    result: unknown,
  ): Promise<void> {
    if (!launcherPresentationGuard()()) return;
    endLauncherExecutionQuery();
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError(
        "maintenance",
        ctx.ui("正在备份或恢复，请稍后重试", "A backup or restore is running. Try again shortly."),
      );
    // The screenshot history belongs to the screenshot plugin; other workspaces
    // keep the one-to-one kind/plugin naming.
    const pluginId = kind === "screenshot-history" ? "spark233.screenshot" : `spark233.${kind}`;
    if (ctx.officialRenderers.get(pluginId)?.scope.state !== "active")
      throw new Error("The plugin workspace is not available");
    const layout: Layout = ctx.layouts.get(kind) ?? {
      label: kind,
      view: "launcher",
      pluginId,
      workspace: kind,
      bounds: ctx.safeBounds({ width: 1040, height: 700 }),
      visible: true,
      topmost: false,
    };
    layout.visible = true;
    const win = ctx.createWindow(layout),
      payload = { kind, result };
    ctx.workspaceRequests.set(ctx.labelOf(win), payload);
    ctx.emit("open-workspace", payload, win);
  }

  async function showClipboardWorkspace(presentation?: {
    compact: boolean;
    position: "cursor" | "edge";
  }): Promise<void> {
    if (!launcherPresentationGuard()()) return;
    endLauncherExecutionQuery();
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
    if (presentation?.compact) {
      if (ctx.clipboardRuntime && !ctx.windows.get("clipboard-quick")?.isFocused())
        await ctx.clipboardRuntime
          .rememberTarget()
          .catch((error) => console.error("clipboard-target", error));
      if (!launcherPresentationGuard()()) return;
      const point = screen.getCursorScreenPoint(),
        area = screen.getDisplayNearestPoint(point).workArea;
      const layout: Layout = ctx.layouts.get("clipboard-quick") ?? {
        label: "clipboard-quick",
        view: "launcher",
        pluginId: "spark233.clipboard",
        workspace: "clipboard",
        compact: true,
        bounds: ctx.safeBounds({ width: 450, height: 400 }),
        visible: true,
        topmost: false,
      };
      layout.bounds = ctx.safeBounds({
        ...layout.bounds,
        x: presentation.position === "edge" ? area.x + area.width - layout.bounds.width : point.x,
        y: point.y,
      });
      layout.visible = true;
      ctx.createWindow(layout);
      return;
    }
    if (ctx.clipboardRuntime && !ctx.windows.get("clipboard")?.isFocused())
      await ctx.clipboardRuntime
        .rememberTarget()
        .catch((error) => console.error("clipboard-target", error));
    if (!launcherPresentationGuard()()) return;
    const layout: Layout = ctx.layouts.get("clipboard") ?? {
      label: "clipboard",
      view: "launcher",
      pluginId: "spark233.clipboard",
      workspace: "clipboard",
      bounds: ctx.safeBounds({ width: 1040, height: 700 }),
      visible: true,
      topmost: false,
    };
    layout.visible = true;
    ctx.createWindow(layout);
  }
  return {
    launcherPresentationGuard,
    endLauncherExecutionQuery,
    launcherCaller,
    hideHostWindow,
    revokeLauncherCaller,
    deliverLauncherQueryUpdate,
    showLauncher,
    presentLauncher,
    openLauncherWindow,
    showLauncherWithSelection,
    prepareSelectionReader,
    cancelSelection,
    stopSelectionReader,
    requestLauncher,
    activateHostCommand,
    showOfficialWorkspace,
    showClipboardWorkspace,
  };
}
