import { app, dialog } from "electron";
import path from "node:path";
import { z } from "zod";
import { DiagnosticsStore, type DiagnosticFilter } from "../diagnostics.js";
import { AppError, atomicWrite, canonical, inside } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createDiagnosticCommands(
  ctx: Pick<
    RuntimeContext,
    | "isAdminView"
    | "diagnostics"
    | "configDir"
    | "launcherCaller"
    | "diagnosticSubscriptions"
    | "launcherCallers"
    | "emit"
    | "ui"
    | "hostConfig"
    | "backupRecoveryDir"
    | "privateDataRoots"
  >,
) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command.startsWith("diagnostics_")) {
      if (!ctx.isAdminView(layout))
        throw new AppError("permissionDenied", "诊断记录仅限宿主管理界面");
      if (!ctx.diagnostics) {
        try {
          ctx.diagnostics = new DiagnosticsStore(path.join(ctx.configDir, "diagnostics"));
          ctx.diagnostics.record({ kind: "host", code: "started", level: "info" });
        } catch {
          /* A retry may recover after an operator repairs the dedicated log directory. */
        }
      }
      if (!ctx.diagnostics) throw new AppError("diagnosticsUnavailable", "诊断记录暂不可用");
      const caller = ctx.launcherCaller(win);
      if (command === "diagnostics_list") {
        const input = z.strictObject({ filter: z.unknown().optional() }).parse(args);
        return ctx.diagnostics.snapshot(input.filter as DiagnosticFilter | undefined);
      }
      if (command === "diagnostics_subscribe") {
        z.strictObject({}).parse(args);
        ctx.diagnosticSubscriptions.get(caller)?.();
        ctx.diagnosticSubscriptions.delete(caller);
        const stop = ctx.diagnostics.subscribe((batch) => {
          if (
            !win.isDestroyed() &&
            !win.webContents.isDestroyed() &&
            ctx.launcherCallers.get(win.webContents.id) === caller
          )
            ctx.emit("diagnostics-batch", batch, win);
        });
        ctx.diagnosticSubscriptions.set(caller, stop);
        return ctx.diagnostics.snapshot();
      }
      if (command === "diagnostics_unsubscribe") {
        z.strictObject({}).parse(args);
        ctx.diagnosticSubscriptions.get(caller)?.();
        ctx.diagnosticSubscriptions.delete(caller);
        return;
      }
      if (command === "diagnostics_clear") {
        z.strictObject({}).parse(args);
        return ctx.diagnostics.clear();
      }
      if (command === "diagnostics_export") {
        const input = z.strictObject({ filter: z.unknown().optional() }).parse(args);
        const snapshot = ctx.diagnostics.export(input.filter as DiagnosticFilter | undefined);
        const chosen = await dialog.showSaveDialog(win, {
          title: ctx.ui("导出诊断记录", "Export diagnostics"),
          defaultPath: path.join(
            app.getPath("documents"),
            `spark233-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
          ),
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (chosen.canceled || !chosen.filePath) return { exported: false };
        if (win.isDestroyed() || ctx.launcherCallers.get(win.webContents.id) !== caller)
          throw new AppError("permissionDenied", "导出窗口文档已失效");
        const destination = canonical(chosen.filePath);
        if (
          [
            ctx.configDir,
            ctx.hostConfig.value.dataDir,
            ctx.backupRecoveryDir,
            ...ctx.privateDataRoots.list(),
          ].some((root) => inside(canonical(root), destination))
        )
          throw new AppError("permissionDenied", "不能将诊断导出覆盖到应用私有数据目录");
        atomicWrite(destination, snapshot);
        return { exported: true };
      }
      throw new AppError("unknownCommand", "未知诊断操作");
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    diagnostics_clear: run,
    diagnostics_export: run,
    diagnostics_list: run,
    diagnostics_subscribe: run,
    diagnostics_unsubscribe: run,
  } satisfies Record<string, CommandHandler>;
}
