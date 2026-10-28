import type { BrowserWindow } from "electron";
import type { DesktopPluginHost } from "../plugins/desktop-host.js";
import type { PluginManagementState } from "../../src/features/plugins/types.js";
import { AppError } from "../persistence.js";

export async function handlePluginCommand(
  options: {
    host?: DesktopPluginHost;
    startupError?: string;
    notesRecoveryPending: boolean;
    caller: (win: BrowserWindow) => string;
    ui: (zh: string, en: string) => string;
  },
  win: BrowserWindow,
  command: string,
  args: Record<string, unknown>,
) {
  const { host, startupError, notesRecoveryPending, caller, ui } = options;
  if (!host) throw new AppError("pluginHostUnavailable", startupError || "插件宿主尚未就绪");
  if (notesRecoveryPending) {
    const state =
      command === "plugins_confirm_install"
        ? ((await host.handle(
            "plugins_list",
            undefined,
            win,
            caller(win),
          )) as PluginManagementState)
        : undefined;
    const replacesRetainedNotes =
      (args.pluginId === "spark233.notes" &&
        (command === "plugins_uninstall" ||
          (command === "plugins_enable" && args.enabled === false))) ||
      state?.pending.some(
        (preview) =>
          preview.previewId === args.previewId && preview.metadata.spark233.id === "spark233.notes",
      );
    if (replacesRetainedNotes)
      throw new AppError(
        "pluginRecoveryRequired",
        ui(
          "请先恢复便签后台并保存保留的编辑窗口",
          "Recover notes and save the retained editors first",
        ),
      );
  }
  const result = await host.handle(command, args, win, caller(win));
  if (command === "plugins_list" && startupError && result && typeof result === "object")
    return { ...result, error: startupError };
  return result;
}
