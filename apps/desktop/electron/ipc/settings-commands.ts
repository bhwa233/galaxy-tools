import { app } from "electron";
import { z } from "zod";
import { configPatchSchema } from "../host-config.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { text } from "./arguments.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createSettingsCommands(
  ctx: Pick<
    RuntimeContext,
    | "isAdminView"
    | "pluginSettings"
    | "settingsCaller"
    | "emit"
    | "openHostSettings"
    | "hideHostWindow"
    | "hostConfig"
    | "notesClient"
    | "registerShortcuts"
    | "notesActive"
    | "syncMcp"
    | "publishPluginTheme"
    | "refreshTray"
    | "migrateNotesDirectory"
    | "hostShortcuts"
  >,
) {
  async function run({ win, command, args, layout, grants }: CommandInvocation): Promise<unknown> {
    if (command === "plugin_settings_get" || command === "plugin_settings_save") {
      if (!ctx.isAdminView(layout))
        throw new AppError("permissionDenied", "插件配置仅限宿主管理界面");
      const input = z
        .strictObject({
          pluginId: z.string().regex(/^[a-z][a-z0-9.-]*$/),
          revision: z.string().length(64).optional(),
          patch: z.unknown().optional(),
        })
        .parse(args);
      if (command === "plugin_settings_get") return ctx.pluginSettings.get(input.pluginId);
      if (!input.revision) throw new AppError("invalidPayload", "缺少配置版本");
      ctx.settingsCaller = win;
      try {
        const result = await ctx.pluginSettings.save(input.pluginId, input.revision, input.patch);
        ctx.emit("plugin-settings-changed", { pluginId: input.pluginId });
        return result;
      } finally {
        ctx.settingsCaller = undefined;
      }
    }
    if (command === "settings_open") {
      if (
        !ctx.isAdminView(layout) &&
        !(args.page === "plugins" && args.pluginId === (layout.pluginId ?? "spark233.notes"))
      )
        throw new AppError("permissionDenied", "只能定位当前插件的设置");
      const target = z
        .strictObject({
          page: z
            .enum(["general", "shortcuts", "tray", "entries", "plugins", "backup", "diagnostics"])
            .default("general"),
          pluginId: z
            .string()
            .regex(/^[a-z][a-z0-9.-]*$/)
            .optional(),
          tab: z.enum(["config", "functions", "matching", "info"]).optional(),
        })
        .parse(args);
      if ((await ctx.openHostSettings(target)) && layout.label === "launcher")
        ctx.hideHostWindow(win);
      return;
    }
    switch (command) {
      case "config_get":
        return ctx.hostConfig.value;
      case "config_save":
        throw new AppError(
          "obsoleteClient",
          "设置页面或便签插件版本过旧，请重新加载页面或更新便签插件",
        );
      case "config_patch": {
        const previous = ctx.hostConfig.value;
        const parsed = configPatchSchema.safeParse(args.patch);
        if (!parsed.success) throw new AppError("invalidPayload", "设置补丁包含不支持的字段或值");
        const patch = parsed.data;
        if (args.expectedShortcuts !== undefined) {
          const expected = z
            .strictObject({
              globalShortcut: z.string().max(100),
              toggleVisibilityShortcut: z.string().max(100),
            })
            .parse(args.expectedShortcuts);
          if (
            Object.entries(expected).some(
              ([key, value]) =>
                previous[key as "globalShortcut" | "toggleVisibilityShortcut"] !== value,
            )
          )
            throw new AppError("settingsConflict", "快捷键设置已变化，请重新加载并核对");
        }
        if (args.expectedCommandShortcuts !== undefined) {
          const expected = z
            .record(z.string(), z.string().max(100))
            .parse(args.expectedCommandShortcuts);
          if (
            Object.keys(expected).length > 128 ||
            Object.entries(expected).some(
              ([key, value]) => (previous.commandShortcuts?.[key] ?? "") !== value,
            )
          )
            throw new AppError("settingsConflict", "快捷键设置已变化，请重新加载并核对");
        }
        const config = {
          ...previous,
          ...patch,
          ...(patch.commandShortcuts
            ? {
                commandShortcuts: { ...previous.commandShortcuts, ...patch.commandShortcuts },
              }
            : {}),
        };
        // Validate/write once before applying OS state, then roll back on native failure.
        if (patch.autostart && !app.isPackaged)
          throw new AppError("developmentOnly", "开机启动请在安装后的版本中设置");
        if (
          config?.backgroundImagePath &&
          config.backgroundImagePath !== previous.backgroundImagePath
        )
          await ctx.notesClient.resolveImage(config.backgroundImagePath);
        ctx.hostConfig.save(config);
        const shortcutsChanged =
          patch.globalShortcut !== undefined ||
          patch.toggleVisibilityShortcut !== undefined ||
          patch.commandShortcuts !== undefined;
        try {
          if (shortcutsChanged) ctx.registerShortcuts(config);
          if (config.autostart !== previous.autostart)
            app.setLoginItemSettings({ openAtLogin: config.autostart, path: process.execPath });
          if (ctx.notesActive && config.locale !== previous.locale)
            await ctx.notesClient.initialize(config.locale);
        } catch (error) {
          ctx.hostConfig.save(previous);
          if (shortcutsChanged) {
            try {
              ctx.registerShortcuts(previous);
            } catch (restoreError) {
              console.error("shortcut-rollback", restoreError);
            }
          }
          throw error;
        }
        ctx.syncMcp();
        ctx.emit("config-changed", ctx.hostConfig.value);
        ctx.publishPluginTheme();
        ctx.refreshTray();
        return ctx.hostConfig.value;
      }
      case "config_migrate_data_dir": {
        const dest = grants.assert(args.newDataDir);
        return ctx.migrateNotesDirectory(dest);
      }
      case "global_shortcut_check":
        return ctx.hostShortcuts.check(text(args.shortcut));
      case "start_shortcut_recording":
        ctx.hostShortcuts.beginRecording();
        return;
      case "stop_shortcut_recording":
        ctx.hostShortcuts.endRecording(ctx.hostConfig.value);
        return;
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    config_get: run,
    config_migrate_data_dir: run,
    config_patch: run,
    config_save: run,
    global_shortcut_check: run,
    plugin_settings_get: run,
    plugin_settings_save: run,
    settings_open: run,
    start_shortcut_recording: run,
    stop_shortcut_recording: run,
  } satisfies Record<string, CommandHandler>;
}
