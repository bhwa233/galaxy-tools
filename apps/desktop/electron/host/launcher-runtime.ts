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
    prepare: () => prepareLauncher(),
    present: async (text, revision, signal) => {
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

  function assertHostAvailable(): void {
    if (ctx.maintenance)
      throw new AppError(
        "maintenance",
        ctx.ui("正在备份或恢复，请稍后重试", "A backup or restore is running. Try again shortly."),
      );
    if (ctx.hostShutdown.isQuitting)
      throw new AppError(
        "hostStopping",
        ctx.ui("正在保存并退出，请稍后重试", "Saving and quitting. Try again shortly."),
      );
  }

  async function prepareLauncher(): Promise<void> {
    assertHostAvailable();
    const closing = ctx.windows.get("launcher");
    if (closing) await ctx.releasing.get(closing.id);
    if (ctx.clipboardRuntime && !hostWindowFocused()) {
      try {
        await ctx.clipboardRuntime.rememberTarget();
      } catch (error) {
        console.error("clipboard-target", error);
      }
    }
  }

  function hostWindowFocused(): boolean {
    return [
      ...ctx.windows.values(),
      ...[...(ctx.capsules?.surfaces.values() ?? [])].map((surface) => surface.win),
    ].some((win) => !win.isDestroyed() && win.isFocused());
  }

  // Both normal opening and selection handoff use the same launcher window.
  function openLauncherWindow(): BrowserWindow {
    assertHostAvailable();
    const layout: Layout = ctx.layouts.get("launcher") ?? {
      label: "launcher",
      view: "launcher",
      bounds: ctx.safeBounds({ width: 760, height: 560 }),
      visible: true,
      topmost: false,
    };
    layout.hostPage = "launcher";
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

  function preloadLauncher(): void {
    if (ctx.windows.has("launcher") || ctx.maintenance || ctx.hostShutdown.isQuitting) return;
    const layout: Layout = {
      ...(ctx.layouts.get("launcher") ?? {
        label: "launcher",
        view: "launcher",
        bounds: ctx.safeBounds({ width: 760, height: 560 }),
        topmost: false,
      }),
      visible: false,
      hostPage: "launcher",
    };
    ctx.createWindow(layout);
  }

  async function activateHostCommand(pluginId: string, commandId: string): Promise<unknown> {
    assertHostAvailable();
    const manager = ctx.pluginHost?.manager;
    const entry = manager
      ?.commands()
      .find((item) => item.pluginId === pluginId && item.command.id === commandId);
    if (!manager || !entry) throw new AppError("pluginDisabled", "插件操作当前不可用");
    if (!entry.command.mode || entry.command.window)
      return manager.activate(pluginId, { commandId });
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
    preloadLauncher,
    activateHostCommand,
  };
}
