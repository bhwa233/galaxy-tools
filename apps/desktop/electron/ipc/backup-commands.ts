import { dialog } from "electron";
import { handleBackupCommand } from "../ipc/backup.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createBackupCommands(
  ctx: Pick<
    RuntimeContext,
    | "isAdminView"
    | "backupService"
    | "backupScheduler"
    | "backupSelections"
    | "launcherCaller"
    | "launcherCallers"
    | "ui"
  >,
) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command.startsWith("backup_")) {
      if (!ctx.isAdminView(layout)) throw new AppError("permissionDenied", "备份恢复仅限宿主界面");
      if (command === "backup_schedule") {
        const scheduler = ctx.backupScheduler;
        if (!scheduler) throw new Error("Backup scheduler is unavailable");
        if (args.action === "get") return scheduler.get();
        if (args.action === "run") return scheduler.run(true);
        if (args.action === "choose") {
          const picked = await dialog.showOpenDialog(win, {
            title: ctx.ui("选择定期备份位置", "Choose scheduled backup destination"),
            properties: ["openDirectory", "createDirectory"],
          });
          return !picked.canceled && picked.filePaths[0]
            ? scheduler.save({}, picked.filePaths[0])
            : scheduler.get();
        }
        if (args.action === "save")
          return scheduler.save({
            enabled: args.enabled,
            intervalDays: args.intervalDays,
            keep: args.keep,
          });
        throw new AppError("invalidPayload", "未知备份计划操作");
      }
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
    backup_schedule: run,
    backup_create: run,
    backup_inspect: run,
    backup_restore: run,
    backup_selection_release: run,
  } satisfies Record<string, CommandHandler>;
}
