import { handlePluginCommand } from "../ipc/plugins.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createPluginCommands(
  ctx: Pick<
    RuntimeContext,
    | "isAdminView"
    | "pluginHost"
    | "pluginHostStartupError"
    | "notesRecoveryPending"
    | "launcherCaller"
    | "ui"
  >,
) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command.startsWith("plugins_")) {
      if (!ctx.isAdminView(layout))
        throw new AppError("permissionDenied", "插件管理仅限宿主主界面");
      return handlePluginCommand(
        {
          host: ctx.pluginHost,
          startupError: ctx.pluginHostStartupError,
          notesRecoveryPending: ctx.notesRecoveryPending,
          caller: ctx.launcherCaller,
          ui: ctx.ui,
        },
        win,
        command,
        args,
      );
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    plugins_activate: run,
    plugins_cancel_install: run,
    plugins_cancel_package_task: run,
    plugins_check_updates: run,
    plugins_confirm_install: run,
    plugins_enable: run,
    plugins_import: run,
    plugins_import_directory: run,
    plugins_list: run,
    plugins_prepare_bundled: run,
    plugins_prepare_registry: run,
    plugins_prepare_update: run,
    plugins_release_notes: run,
    plugins_uninstall: run,
  } satisfies Record<string, CommandHandler>;
}
