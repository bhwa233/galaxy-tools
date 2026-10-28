import { BrowserWindow } from "electron";
import type { AppConfig } from "../../src/features/settings/types.js";
import { type CliCommand } from "../cli-args.js";
import type { RuntimeContext } from "../runtime.js";

/** surface-commands owns this domain; shared state remains in the composition root. */
export function createSurfaceCommands(
  ctx: Pick<
    RuntimeContext,
    | "windows"
    | "capsules"
    | "hideHostWindow"
    | "layouts"
    | "createWindow"
    | "showMain"
    | "maintenance"
    | "hostShutdown"
    | "openNote"
    | "reportError"
    | "requestLauncher"
    | "quit"
    | "hostShortcuts"
    | "shortcutWarning"
    | "emit"
  >,
) {
  function visibleSurfaceWindows(): BrowserWindow[] {
    return [
      ...ctx.windows.values(),
      ...[...(ctx.capsules?.surfaces.values() ?? [])].map((surface) => surface.win),
    ].filter((win) => win.isVisible());
  }

  function hideAllSurfaces(): void {
    for (const win of visibleSurfaceWindows()) ctx.hideHostWindow(win);
    ctx.capsules.setHidden(true);
  }

  function showAllSurfaces(): void {
    const notes = [...ctx.layouts.values()].filter(
      (entry) => entry.visible && entry.view !== "main",
    );
    ctx.capsules.setHidden(false);
    if (notes.length)
      for (const entry of notes)
        if (!entry.folded) ctx.createWindow(entry).show();
        else ctx.showMain();
    else ctx.showMain();
  }

  function toggleAllSurfaces(): void {
    if (visibleSurfaceWindows().length) hideAllSurfaces();
    else showAllSurfaces();
  }

  function executeCliCommand(command: CliCommand): void {
    if (ctx.maintenance || ctx.hostShutdown.isQuitting) {
      console.error("正在备份或恢复，CLI 操作未执行");
      return;
    }
    switch (command) {
      case "new":
        void ctx.openNote().catch(ctx.reportError);
        return;
      case "show":
        ctx.requestLauncher();
        return;
      case "hide":
        hideAllSurfaces();
        return;
      case "toggle":
        toggleAllSurfaces();
        return;
      case "list":
        ctx.showMain();
        return;
      case "exit":
        void ctx.quit();
        return;
    }
  }

  function registerShortcuts(config: AppConfig): void {
    try {
      ctx.hostShortcuts.configure(config);
      ctx.shortcutWarning = undefined;
    } catch (error) {
      ctx.shortcutWarning = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      ctx.emit("launcher-status-changed");
    }
  }
  return {
    visibleSurfaceWindows,
    hideAllSurfaces,
    showAllSurfaces,
    toggleAllSurfaces,
    executeCliCommand,
    registerShortcuts,
  };
}
