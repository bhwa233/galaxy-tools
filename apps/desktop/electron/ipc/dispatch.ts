import { BrowserWindow } from "electron";
import type { CommandName } from "../../shared/command-policies.js";
import { notesCommandAllowed } from "../host/ipc-policy.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { createApplicationCommands } from "./application-commands.js";
import { createBackupCommands } from "./backup-commands.js";
import { createDiagnosticCommands } from "./diagnostic-commands.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
import { createLauncherCommands } from "./launcher-commands.js";
import { createNoteCommands } from "./note-commands.js";
import { createPlatformCommands } from "./platform-commands.js";
import { createPluginCommands } from "./plugin-commands.js";
import { createSearchCommands } from "./search-commands.js";
import { createSettingsCommands } from "./settings-commands.js";
import { createWindowCommands } from "./window-commands.js";
import { createWorkspaceCommands } from "./workspace-commands.js";
export function createDispatch(ctx: RuntimeContext) {
  const handlers = {
    ...createLauncherCommands(ctx),
    ...createSettingsCommands(ctx),
    ...createDiagnosticCommands(ctx),
    ...createPluginCommands(ctx),
    ...createApplicationCommands(ctx),
    ...createBackupCommands(ctx),
    ...createWorkspaceCommands(ctx),
    ...createSearchCommands(ctx),
    ...createNoteCommands(ctx),
    ...createWindowCommands(ctx),
    ...createPlatformCommands(ctx),
  } satisfies Record<Exclude<CommandName, `capsule_${string}`>, CommandHandler>;
  async function handle(
    win: BrowserWindow,
    command: CommandName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const grants = ctx.grantsFor(win);
    const preparing = [...ctx.pending.values()].some((request) => request.windowId === win.id);
    const preparationWrite =
      preparing &&
      (/^(notes_(create|update|set_editor_mode)|images_save|save_external_file)$/.test(command) ||
        (command === "clipboard_action" && args.action === "draft.save") ||
        (command === "ocr_action" && args.action === "save") ||
        (command === "backup_schedule" && args.action === "save") ||
        ["config_patch", "plugin_settings_save"].includes(command));
    const readOnly = [
      "desktop_ready",
      "desktop_prepare_report",
      "config_get",
      "app_version",
      "app_name",
      "app_exec_path",
      "plugins_list",
      "diagnostics_list",
      "diagnostics_subscribe",
      "diagnostics_unsubscribe",
      "backup_selection_release",
      "launcher_state",
      "plugin_window_info",
      "plugin_window_take_activation",
      "notes_get",
      "notes_list",
      "categories_list",
      "images_get_base_dir",
      "note_window_states",
      "reminders_list",
      "take_startup_file",
    ];
    const windowRead =
      command === "window_control" &&
      ["bounds", "position", "size", "isMaximized", "isAlwaysOnTop"].includes(String(args.action));
    const restoredSurface =
      command === "surface_state" && ctx.layouts.get(ctx.labelOf(win))?.noteId === args.noteId;
    if (
      (ctx.maintenance || ctx.hostShutdown.isQuitting) &&
      !readOnly.includes(command) &&
      !(command === "backup_schedule" && args.action === "get") &&
      !windowRead &&
      !restoredSurface &&
      !preparationWrite
    )
      throw new AppError(
        ctx.hostShutdown.isQuitting ? "hostStopping" : "maintenance",
        ctx.hostShutdown.isQuitting ? "正在保存并退出，请稍后重试" : "正在备份或恢复，请稍后重试",
      );
    if (
      ctx.notesScope &&
      ctx.notesScope.state !== "active" &&
      ctx.preparedWindows.has(win.id) &&
      /^(notes_(create|update|set_editor_mode)|images_save)/.test(command)
    )
      throw new AppError("pluginStopping", "便签已确认保存，正在停止，请稍后重试");
    if (
      command === "clipboard_action" &&
      args.action === "draft.save" &&
      ctx.preparedWindows.has(win.id) &&
      ctx.officialRenderers.get("spark233.clipboard")?.scope.state !== "active"
    )
      throw new AppError(
        "pluginStopping",
        "The clipboard workspace has already acknowledged saving",
      );
    if (
      command === "ocr_action" &&
      args.action === "save" &&
      ctx.preparedWindows.has(win.id) &&
      ctx.officialRenderers.get("spark233.ocr")?.scope.state !== "active"
    )
      throw new AppError("pluginStopping", "OCR workspace has already acknowledged saving");
    if (ctx.capsules.owns(win)) return ctx.capsules.handle(win, command, args);
    const label = ctx.labelOf(win),
      layout = ctx.layouts.get(label)!;
    if (!layout.pluginId && layout.view !== "launcher" && !notesCommandAllowed(command))
      throw new AppError("permissionDenied", "便签窗口不能调用宿主管理接口");
    if (layout.pluginId) {
      const common = [
        "desktop_ready",
        "settings_open",
        "desktop_prepare_report",
        "config_get",
        "app_version",
        "app_name",
        "app_exec_path",
        "launcher_state",
        "launcher_take_workspace",
        "plugin_window_info",
        "plugin_window_take_activation",
        "launcher_return",
        "window_control",
        "text_action",
        "clipboard_write",
      ];
      const business: Record<string, string[]> = {
        "spark233.clipboard": ["clipboard_action", "clipboard_image_ocr"],
        "spark233.translation": ["translation_action", "translation_configure"],
        "spark233.ocr": ["ocr_action"],
        "spark233.screenshot": ["screenshot_action"],
        "spark233.search": ["search_action", "search_workspace"],
      };
      if (!common.includes(command) && !business[layout.pluginId]?.includes(command))
        throw new AppError("permissionDenied", "此插件工作区不能调用宿主管理接口");
    }
    const handler = handlers[command as keyof typeof handlers];
    if (!handler) throw new AppError("invalidCommand", "Unknown host command");
    return handler({
      win,
      command,
      args,
      layout,
      grants,
      preparationWrite,
      label,
    } as CommandInvocation);
  }
  return { handle };
}
