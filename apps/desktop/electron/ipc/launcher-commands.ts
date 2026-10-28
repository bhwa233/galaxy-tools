import { app, dialog, nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError, atomicWrite } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createLauncherCommands(
  ctx: Pick<
    RuntimeContext,
    | "launcherComposition"
    | "isHostView"
    | "launcher"
    | "launcherCaller"
    | "isAdminView"
    | "workspaceRequests"
    | "pluginHost"
    | "showLauncher"
    | "hideAndRelease"
    | "launcherDialogs"
    | "ui"
    | "launcherExecutions"
    | "clearLauncherContext"
    | "IMAGE_FILE"
    | "configDir"
    | "pluginImages"
    | "launcherContext"
    | "pluginFiles"
  >,
) {
  async function run({
    win,
    command,
    args,
    layout,
    grants,
    label,
  }: CommandInvocation): Promise<unknown> {
    if (command === "launcher_composition") {
      if (layout.label !== "launcher") throw new AppError("permissionDenied", "此窗口不是启动器");
      const input = z.strictObject({ active: z.boolean() }).parse(args);
      if (input.active) ctx.launcherComposition.set(win.id, Date.now() + 10000);
      else ctx.launcherComposition.delete(win.id);
      return;
    }
    if (command.startsWith("launcher_")) {
      if (!ctx.isHostView(layout)) throw new AppError("permissionDenied", "启动器操作仅限宿主界面");
      switch (command) {
        case "launcher_state":
          return ctx.launcher.state(ctx.launcherCaller(win));
        case "launcher_preference_update":
          return ctx.launcher.updatePreference(args, ctx.launcherCaller(win));
        case "launcher_learning_update":
          if (!ctx.isAdminView(layout))
            throw new AppError("permissionDenied", "关键词学习仅限宿主管理界面");
          return ctx.launcher.updateLearning(args, ctx.launcherCaller(win));
        case "launcher_enter_mode":
          return ctx.launcher.enterMode(args, ctx.launcherCaller(win));
        case "launcher_take_workspace": {
          const value = ctx.workspaceRequests.get(label);
          ctx.workspaceRequests.delete(label);
          if (value?.kind === "launcher-mode") {
            const request = z
              .object({ pluginId: z.string(), commandId: z.string(), version: z.string() })
              .parse(value.result);
            ctx.pluginHost?.manager.assertCommandAvailable(request.pluginId, request.commandId);
            if (
              !ctx.pluginHost ||
              ctx.pluginHost.manager.describe(request.pluginId).version !== request.version
            )
              throw new AppError("pluginDisabled", "插件已更新，请重新执行操作");
          }
          return value;
        }
        case "launcher_return":
          await ctx.showLauncher();
          await ctx.hideAndRelease(win);
          return;
        case "launcher_query": {
          let queryArgs = args;
          if (args.directory !== undefined) {
            const directory = grants.assert(args.directory);
            if (!fs.statSync(directory).isDirectory())
              throw new Error("Search directory is not a directory");
            queryArgs = { ...args, directory };
          }
          return ctx.launcher.query(queryArgs, ctx.launcherCaller(win));
        }
        case "launcher_cancel_query": {
          if (
            typeof args.sessionId !== "string" ||
            args.sessionId.length > 100 ||
            (args.requestId !== undefined &&
              (typeof args.requestId !== "string" || args.requestId.length > 100))
          )
            throw new Error("Invalid query cancellation");
          ctx.launcher.clear(ctx.launcherCaller(win), args.sessionId, args.requestId);
          return;
        }
        case "launcher_pick_directory": {
          ctx.launcherDialogs.add(win.id);
          try {
            const picked = await dialog.showOpenDialog(win, {
              title: ctx.ui("选择搜索目录", "Choose a search directory"),
              properties: ["openDirectory"],
            });
            if (picked.canceled || !picked.filePaths[0]) return;
            grants.grant(picked.filePaths[0], true);
            return picked.filePaths[0];
          } finally {
            ctx.launcherDialogs.delete(win.id);
          }
        }
        case "launcher_execute": {
          const callerId = ctx.launcherCaller(win);
          const execution = {
            callerId,
            active: true,
            query: ctx.launcher.queryIdentity(callerId),
          };
          return ctx.launcherExecutions.run(execution, async () => {
            try {
              return await ctx.launcher.execute(args, execution.callerId);
            } finally {
              execution.active = false;
            }
          });
        }
        case "launcher_complete_onboarding":
          ctx.launcher.completeOnboarding();
          return ctx.launcher.state();
        case "launcher_hide":
          ctx.launcher.clear(ctx.launcherCaller(win));
          await ctx.hideAndRelease(win);
          return;
        case "launcher_context_clear":
          ctx.clearLauncherContext();
          return ctx.launcher.state(ctx.launcherCaller(win));
        case "launcher_context_files": {
          if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 100)
            throw new Error("拖入文件不合法");
          const files = args.paths.map((value) => grants.assert(value));
          ctx.clearLauncherContext();
          if (files.length === 1 && ctx.IMAGE_FILE.test(files[0])) {
            if (fs.statSync(files[0]).size > 32 * 1024 * 1024) throw new Error("图片超过 32 MiB");
            const image = nativeImage.createFromPath(files[0]),
              size = image.getSize();
            if (image.isEmpty() || size.width * size.height > 100_000_000)
              throw new Error("无法读取此图片");
            const id = randomUUID(),
              filename = path.join(ctx.configDir, "launcher-resources", `${id}.png`);
            atomicWrite(filename, image.toPNG());
            const resource = { id, kind: "image" as const, mimeType: "image/png" };
            ctx.pluginImages.set(id, {
              owner: { pluginId: "spark233.host", version: app.getVersion(), instanceId: id },
              sessionId: id,
              path: filename,
              resource,
              width: size.width,
              height: size.height,
            });
            ctx.launcherContext = {
              context: { kind: "image", resource },
              label: path.basename(files[0]),
            };
          } else {
            ctx.launcherContext = {
              context: {
                kind: "files",
                resources: files.map((file) => {
                  const id = randomUUID();
                  ctx.pluginFiles.set(id, file);
                  return { id, kind: "file" as const, size: fs.statSync(file).size };
                }),
              },
              label: ctx.ui(`${files.length} 个文件`, `${files.length} files`),
            };
          }
          return ctx.launcher.state();
        }
        default:
          throw new AppError("invalidPayload", "未知启动器命令");
      }
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    launcher_cancel_query: run,
    launcher_complete_onboarding: run,
    launcher_composition: run,
    launcher_context_clear: run,
    launcher_context_files: run,
    launcher_enter_mode: run,
    launcher_execute: run,
    launcher_hide: run,
    launcher_learning_update: run,
    launcher_pick_directory: run,
    launcher_preference_update: run,
    launcher_query: run,
    launcher_return: run,
    launcher_state: run,
    launcher_take_workspace: run,
  } satisfies Record<string, CommandHandler>;
}
