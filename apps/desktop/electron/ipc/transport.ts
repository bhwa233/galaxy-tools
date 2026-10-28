import { BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createCommandRegistry } from "../ipc/registry.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { FileGrants } from "../security.js";

/** transport owns this domain; shared state remains in the composition root. */
export function createTransport(
  ctx: Pick<
    RuntimeContext,
    | "officialWindows"
    | "officialRenderers"
    | "devUrl"
    | "layouts"
    | "labelOf"
    | "windows"
    | "capsules"
    | "handle"
    | "nativeDialogDepth"
    | "mutations"
    | "backupRecoveryPending"
    | "emit"
    | "hostConfig"
    | "TEXT_FILE"
    | "IMAGE_FILE"
    | "isAdminView"
    | "launcherCaller"
    | "applicationEntries"
    | "fileGrants"
  >,
) {
  function sender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const win = BrowserWindow.fromWebContents(event.sender);
    const frame = event.senderFrame;
    const owner = win ? ctx.officialWindows.get(win.id) : undefined;
    const ownedRenderer = owner ? ctx.officialRenderers.get(owner.pluginId) : undefined;
    if (owner && (!ownedRenderer || !ownedRenderer.scope.accepts(owner)))
      throw new AppError("permissionDenied", "Plugin window instance has expired");
    // In development every window, plugin workspaces included, is served by the
    // Vite dev server, so its origin replaces the packaged workspace scheme. The
    // window identity and resource-scope checks below still gate the caller.
    const expectedOrigin = owner
      ? ctx.devUrl
        ? new URL(ctx.devUrl).origin
        : "spark233://workspace"
      : ctx.devUrl
        ? new URL(ctx.devUrl).origin
        : win && ctx.layouts.get(ctx.labelOf(win))?.view === "launcher"
          ? "spark233://app"
          : "spark233://notes";
    if (
      !win ||
      (!ctx.windows.has(ctx.labelOf(win)) && !ctx.capsules?.owns(win)) ||
      !frame ||
      frame !== event.sender.mainFrame ||
      frame.origin !== expectedOrigin
    )
      throw new AppError("permissionDenied", "拒绝非应用窗口 IPC");
    return win;
  }

  function setupIpc(): void {
    const commands = createCommandRegistry(ctx.handle);
    ipcMain.handle("spark233:invoke", async (event, command: unknown, args: unknown) => {
      try {
        const win = sender(event);
        if (
          typeof command !== "string" ||
          command.length > 100 ||
          (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))
        )
          throw new AppError("invalidPayload", "IPC 参数不合法");
        const entry = commands.resolve(command, args);
        const run = async () => {
          const modal = entry.modal;
          if (modal)
            ctx.nativeDialogDepth.set(win.id, (ctx.nativeDialogDepth.get(win.id) ?? 0) + 1);
          try {
            return await entry.run(win);
          } finally {
            if (modal) {
              const count = (ctx.nativeDialogDepth.get(win.id) ?? 1) - 1;
              if (count) ctx.nativeDialogDepth.set(win.id, count);
              else ctx.nativeDialogDepth.delete(win.id);
            }
          }
        };
        // Disk writes and read/modify/write metadata transactions are globally serialized.
        const queued = entry.serialized;
        const value = queued
          ? await (ctx.mutations = ctx.mutations.catch(() => {}).then(run))
          : await run();
        return { ok: true, value };
      } catch (error) {
        if (error instanceof AppError && error.code === "backupRecoveryRequired")
          ctx.backupRecoveryPending = true;
        return {
          ok: false,
          error: {
            code: error instanceof AppError ? error.code : "io",
            message: error instanceof Error ? error.message : String(error),
            details: error instanceof AppError ? error.details : {},
          },
        };
      }
    });
    ipcMain.handle("spark233:emit", (event, name, payload) => {
      sender(event);
      if (name === "config-changed") {
        ctx.emit("config-changed", ctx.hostConfig.value);
        return;
      }
      if (!["tile-window-unpinned"].includes(name) || typeof payload !== "string")
        throw new AppError("permissionDenied", "不允许发布此事件");
      ctx.emit(name, payload);
    });
    ipcMain.handle("spark233:drop", async (event, paths: unknown) => {
      const win = sender(event);
      const allowAnyFile = ctx.layouts.get(ctx.labelOf(win))?.view === "launcher";
      if (
        !Array.isArray(paths) ||
        paths.length > 100 ||
        paths.some(
          (p) =>
            typeof p !== "string" ||
            !path.isAbsolute(p) ||
            !(allowAnyFile || ctx.TEXT_FILE.test(p) || ctx.IMAGE_FILE.test(p)),
        )
      )
        throw new AppError("permissionDenied", "拖入文件不合法");
      try {
        const stats = await Promise.all((paths as string[]).map((file) => fs.promises.stat(file)));
        if (stats.some((stat) => !stat.isFile())) throw new Error("Expected files");
      } catch {
        throw new AppError("permissionDenied", "拖入文件不存在或不可访问");
      }
      if (win.isDestroyed()) throw new AppError("cancelled", "窗口已关闭");
      for (const file of paths) grantsFor(win).grant(file);
      return paths;
    });
    ipcMain.handle("spark233:application-drop", (event, paths: unknown) => {
      const win = sender(event);
      if (!ctx.isAdminView(ctx.layouts.get(ctx.labelOf(win))!))
        throw new AppError("permissionDenied", "Entry drops require the host management view");
      if (
        !Array.isArray(paths) ||
        paths.length > 100 ||
        paths.some((value) => typeof value !== "string")
      )
        throw new AppError("permissionDenied", "Invalid dropped entry targets");
      const caller = ctx.launcherCaller(win);
      return paths.map((location) => ctx.applicationEntries.admit(caller, location));
    });
  }

  function grantsFor(win: BrowserWindow): FileGrants {
    let grants = ctx.fileGrants.get(win);
    if (!grants) {
      grants = new FileGrants();
      ctx.fileGrants.set(win, grants);
    }
    return grants;
  }
  return { sender, setupIpc, grantsFor };
}
