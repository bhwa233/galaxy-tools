import { app, clipboard, dialog, shell } from "electron";
import { openDialog, saveDialog } from "../ipc/dialogs.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { externalUrl } from "../security.js";
import { text } from "./arguments.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createPlatformCommands(ctx: Pick<RuntimeContext, "updateService">) {
  async function run({ win, command, args, grants }: CommandInvocation): Promise<unknown> {
    switch (command) {
      case "app_version":
        return app.getVersion();
      case "app_name":
        return "spark233";
      case "app_exec_path":
        return process.execPath;
      case "app_mcp_command":
        return {
          command: process.execPath,
          args: app.isPackaged ? ["--mcp"] : [app.getAppPath(), "--mcp"],
        };
      case "update_status":
        return ctx.updateService.status();
      case "update_check":
        return ctx.updateService.check(args.manual);
      case "update_download":
        return ctx.updateService.download(args.source);
      case "update_install":
        return ctx.updateService.install();
      case "update_cancel":
        ctx.updateService.cancel();
        return;
      case "update_settings_get":
        return ctx.updateService.settingsGet();
      case "update_settings_save":
        return ctx.updateService.settingsSave(args.settings);
      case "update_mirror_chyan_cdk_get":
        return ctx.updateService.mirrorChyanCdk();
      case "update_mirror_chyan_cdk_set":
        ctx.updateService.setMirrorChyanCdk(args.cdk);
        return;
      case "update_mirror_chyan_cdk_clear":
        ctx.updateService.clearMirrorChyanCdk();
        return;
      case "update_install_prepare_report":
        return;
      case "dialog_open":
        return openDialog(win, args, grants);
      case "dialog_save":
        return saveDialog(win, args, grants);
      case "dialog_message":
        await dialog.showMessageBox(win, {
          message: text(args.text),
          title: args.title || "spark233",
          type: args.kind === "error" ? "error" : "info",
        });
        return;
      case "shell_open":
        await shell.openExternal(externalUrl(args.url));
        return;
      case "clipboard_read":
        return clipboard.readText();
      case "clipboard_write":
        clipboard.writeText(text(args.text));
        return;
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    app_exec_path: run,
    app_mcp_command: run,
    app_name: run,
    app_version: run,
    clipboard_read: run,
    clipboard_write: run,
    dialog_message: run,
    dialog_open: run,
    dialog_save: run,
    shell_open: run,
    update_cancel: run,
    update_check: run,
    update_download: run,
    update_install: run,
    update_install_prepare_report: run,
    update_mirror_chyan_cdk_clear: run,
    update_mirror_chyan_cdk_get: run,
    update_mirror_chyan_cdk_set: run,
    update_settings_get: run,
    update_settings_save: run,
    update_status: run,
  } satisfies Record<string, CommandHandler>;
}
