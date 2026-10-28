import { handleBackupCommand } from "../ipc/backup.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createBackupCommands(
  ctx: Pick<
    RuntimeContext,
    | "isAdminView"
    | "backupService"
    | "backupSelections"
    | "launcherCaller"
    | "launcherCallers"
    | "ui"
  >,
) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command.startsWith("backup_")) {
      if (!ctx.isAdminView(layout)) throw new AppError("permissionDenied", "备份恢复仅限宿主界面");
      return handleBackupCommand(
        {
          service: ctx.backupService,
          selections: ctx.backupSelections,
          caller: ctx.launcherCaller,
          currentCaller: (window) => ctx.launcherCallers.get(window.webContents.id),
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
    backup_create: run,
    backup_inspect: run,
    backup_restore: run,
    backup_selection_release: run,
  } satisfies Record<string, CommandHandler>;
}
