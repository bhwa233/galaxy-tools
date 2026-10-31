import { commandMatchesSourceApplication, localizePluginManifest } from "@spark233/sdk";
import { BrowserWindow, screen } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NativeSelectionReader } from "../selection-native.js";
import { SelectionLauncher } from "../selection-launcher.js";
import { AppError } from "../persistence.js";
import type { Layout, RuntimeContext } from "../runtime.js";
import { markPresented, presentationCount } from "./presentation-epoch.js";

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
  let settling: Promise<void> | undefined;
  const timelineEnabled = process.env.SPARK233_LAUNCHER_TIMELINE === "1";
  function timeline(event: string, started: number): void {
    if (timelineEnabled)
      console.info("launcher-timeline", event, Math.round(performance.now() - started));
  }
  /** The first handoff owns the fresh input; a late UIA patch only fills an
   * input the user has not started editing. */
  function deliverLauncherInput(
    win: BrowserWindow,
    text: string,
    revision: number,
    initial: boolean,
  ): void {
    if (win.isDestroyed()) return;
    if (initial) {
      const payload = { kind: "launcher-input", result: { text, revision } };
      ctx.workspaceRequests.set("launcher", payload);
      if (ctx.ready.has(win.id)) ctx.emit("open-workspace", payload, win);
      return;
    }
    const payload = { text, revision };
    if (ctx.ready.has(win.id)) ctx.emit("launcher-input-updated", payload, win);
    else ctx.workspaceRequests.set("launcher", { kind: "launcher-input", result: payload });
  }
  const selectionLauncher = new SelectionLauncher({
    target: async (signal) => {
      const started = performance.now();
      const target = await getReader().target(signal);
      if (timelineEnabled) timeline(`selection-target ${target}`, started);
      return target;
    },
    read: async (signal, target) => {
      const started = performance.now();
      const text = await getReader().read(signal, target);
      if (timelineEnabled)
        timeline(`selection-read target=${target} chars=${text.length}`, started);
      return text;
    },
    present: (text, revision, signal) => {
      if (signal.aborted) return;
      if (ctx.maintenance || ctx.hostShutdown.isQuitting) return;
      const started = performance.now();
      ctx.clearLauncherContext();
      const win = ctx.launcherExecutions.exit(() => openLauncherWindow());
      timeline("selection-shown", started);
      deliverLauncherInput(win, text, revision, true);
    },
    patch: (text, revision, signal) => {
      if (signal.aborted) return;
      const win = ctx.windows.get("launcher");
      if (win) deliverLauncherInput(win, text, revision, false);
      if (timelineEnabled)
        console.info("launcher-timeline", "selection-patch", text.length, revision);
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
    if (ctx.windows.get("launcher") !== win || !ctx.ready.has(id)) {
      win.hide();
      return;
    }
    // Paint the cleared home frame before the window leaves the screen: a hidden
    // renderer is throttled, so without this the compositor would keep showing
    // the frame captured before the close.
    const presented = presentationCount(win);
    const started = performance.now();
    ctx.emit("launcher-reset", undefined, win);
    win.webContents.setBackgroundThrottling(false);
    const settle = () => {
      win.webContents.setBackgroundThrottling(true);
      if (presentationCount(win) !== presented) return;
      win.hide();
      if (timelineEnabled) timeline("launcher-hidden", started);
    };
    setTimeout(settle, 40);
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

  /** Show first: the panel never waits for a pending close, clipboard capture
   * or UIA work. Those settle in the background with their own diagnostics. */
  function presentLauncher(): Promise<BrowserWindow> {
    assertHostAvailable();
    const started = performance.now();
    // Fire the paste-target capture before showing; awaiting it (150 ms cap)
    // would delay the panel, and after show() the captured target would be the
    // launcher itself.
    if (ctx.clipboardRuntime && !hostWindowFocused())
      void ctx.clipboardRuntime
        .rememberTarget()
        .catch((error: unknown) => console.error("clipboard-target", error));
    const win = openLauncherWindow();
    timeline("launcher-shown", started);
    settleLauncherPreparation();
    return Promise.resolve(win);
  }

  function settleLauncherPreparation(): void {
    void (settling ??= prepareLauncher()
      .catch((error: unknown) => console.error("launcher-prepare", error))
      .finally(() => {
        settling = undefined;
      }));
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

  /** Background follow-up to a show that already happened. It only waits for a
   * closing launcher to finish releasing so a stale release cannot hide the
   * window we just presented. */
  async function prepareLauncher(): Promise<void> {
    const closing = ctx.windows.get("launcher");
    if (closing) await ctx.releasing.get(closing.id);
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
    markPresented(win);
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
