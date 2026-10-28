import { dialog } from "electron";
import path from "node:path";
import { readApplicationSettings } from "../application-settings.js";
import { AppError, atomicWrite } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createApplicationCommands(
  ctx: Pick<
    RuntimeContext,
    | "isAdminView"
    | "pluginHost"
    | "launcherCaller"
    | "ui"
    | "launcherCallers"
    | "applicationEntries"
    | "launcher"
    | "launcherAvailabilityRevision"
    | "emit"
  >,
) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command.startsWith("applications_entries_")) {
      if (!ctx.isAdminView(layout))
        throw new AppError("permissionDenied", "Custom application settings require the host view");
      if (!ctx.pluginHost) throw new Error("Plugin host is not ready");
      if (command === "applications_entries_pick") {
        if (
          (args.purpose !== "target" && args.purpose !== "cwd") ||
          (args.directory !== undefined && typeof args.directory !== "boolean")
        )
          throw new AppError("invalidPayload", "Unknown entry selection purpose");
        const caller = ctx.launcherCaller(win);
        const picked = await dialog.showOpenDialog(win, {
          title:
            args.purpose === "cwd"
              ? ctx.ui("选择程序工作目录", "Choose the working directory")
              : args.directory
                ? ctx.ui("选择文件夹入口", "Choose a folder shortcut")
                : ctx.ui("选择文件或程序入口", "Choose a file or application"),
          properties: [args.directory || args.purpose === "cwd" ? "openDirectory" : "openFile"],
        });
        if (picked.canceled || !picked.filePaths[0]) return;
        if (win.isDestroyed() || ctx.launcherCallers.get(win.webContents.id) !== caller)
          throw new AppError("permissionDenied", "Entry selection belongs to a closed document");
        return ctx.applicationEntries.admit(
          caller,
          picked.filePaths[0],
          args.directory || args.purpose === "cwd" ? "directory" : undefined,
        );
      }
      const installation = ctx.pluginHost.manager
        .list()
        .find((plugin) => plugin.pluginId === "spark233.applications");
      if (!installation) throw new Error("Applications plugin is not installed");
      ctx.pluginHost.manager.describe("spark233.applications");
      const file = path.join(
        ctx.pluginHost.manager.dataDirectory("spark233.applications"),
        "custom-entries.json",
      );
      const identity = JSON.stringify([
        installation.packageName,
        installation.version,
        installation.integrity,
      ]);
      if (command === "applications_entries_get") return readApplicationSettings(file, identity);
      if (command === "applications_entries_save") {
        const current = readApplicationSettings(file, identity);
        if (args.revision !== current.revision)
          throw new AppError("settingsConflict", "应用入口已发生变化，请重新加载后核对");
        const entries = ctx.applicationEntries.validate(
          ctx.launcherCaller(win),
          current.entries,
          args.entries,
        );
        if (Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024)
          throw new Error("Application settings exceed size limit");
        ctx.launcher.clear();
        if (installation.status === "active")
          await ctx.pluginHost.manager.activate("spark233.applications", {
            commandId: "settings",
            parameters: { action: "save", entries: entries.map((entry) => ({ ...entry })) },
          });
        else atomicWrite(file, JSON.stringify({ version: 2, entries }));
        ctx.launcher.invalidateApplicationAvailability();
        ctx.launcher.clear();
        ctx.launcherAvailabilityRevision++;
        ctx.emit("plugins-changed");
        ctx.emit("launcher-status-changed");
        return readApplicationSettings(file, identity);
      }
      throw new AppError("invalidPayload", "Unknown custom application command");
    }
    if (command.startsWith("search_scope_")) {
      if (!ctx.isAdminView(layout))
        throw new AppError("permissionDenied", "Search scope settings require the host view");
      if (!ctx.pluginHost) throw new Error("Plugin host is not ready");
      if (command === "search_scope_pick") {
        const picked = await dialog.showOpenDialog(win, {
          title: ctx.ui("选择要排除的目录或卷", "Choose a directory or volume to exclude"),
          properties: ["openDirectory"],
        });
        return picked.canceled ? undefined : picked.filePaths[0];
      }
      if (command === "search_scope_get")
        return ctx.pluginHost.manager.activate("spark233.search", {
          commandId: "settings",
          parameters: { action: "get" },
        });
      if (command === "search_scope_save") {
        if (
          !Array.isArray(args.excludedRoots) ||
          args.excludedRoots.some((root: unknown) => typeof root !== "string")
        )
          throw new AppError("invalidPayload", "Expected excluded directory paths");
        ctx.launcher.clear();
        const result = await ctx.pluginHost.manager.activate("spark233.search", {
          commandId: "settings",
          parameters: {
            action: "save",
            excludedRoots: args.excludedRoots,
            ...(args.extensions !== undefined ? { extensions: args.extensions } : {}),
            ...(args.maxFileMiB !== undefined ? { maxFileMiB: args.maxFileMiB } : {}),
            ...(args.includeHidden !== undefined ? { includeHidden: args.includeHidden } : {}),
          },
        });
        ctx.launcher.clear();
        ctx.emit("search-scope-changed");
        return result;
      }
      throw new AppError("invalidPayload", "Unknown search scope command");
    }
    if (command.startsWith("search_service_")) {
      if (!ctx.isAdminView(layout))
        throw new AppError("permissionDenied", "Search service settings require the host view");
      if (!ctx.pluginHost) throw new Error("Plugin host is not ready");
      const actions: Record<string, string> = {
        search_service_status: "status",
        search_service_configure: "configure",
        search_service_rebuild: "rebuild",
      };
      const action = actions[command];
      if (!action) throw new AppError("invalidPayload", "Unknown search service action");
      const result = await ctx.pluginHost.manager.activate("spark233.search", {
        commandId: "service",
        parameters: {
          action,
          ...(command === "search_service_configure"
            ? { excludedRoots: args.excludedRoots, volumeEnabled: args.volumeEnabled }
            : {}),
        },
      });
      if (action !== "status") {
        ctx.launcher.clear();
        ctx.emit("search-scope-changed");
      }
      return result;
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    applications_entries_get: run,
    applications_entries_pick: run,
    applications_entries_save: run,
    search_scope_get: run,
    search_scope_pick: run,
    search_scope_save: run,
    search_service_configure: run,
    search_service_rebuild: run,
    search_service_status: run,
  } satisfies Record<string, CommandHandler>;
}
