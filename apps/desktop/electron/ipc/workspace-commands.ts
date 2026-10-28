import { ClipboardItem, clipboard, dialog, nativeImage } from "electron";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ClipboardRequest } from "../../src/features/clipboard/types.js";
import { CaptureHistory } from "../plugins/official/capture-history.js";
import { AppError, atomicWrite } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { text } from "./arguments.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createWorkspaceCommands(
  ctx: Pick<
    RuntimeContext,
    | "isHostView"
    | "pluginHost"
    | "showOfficialWorkspace"
    | "translationSettings"
    | "officialRenderers"
    | "clipboardRuntime"
    | "pluginImages"
    | "ui"
  >,
) {
  async function run({ command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command === "text_action") {
      if (!ctx.isHostView(layout)) throw new AppError("permissionDenied", "文本动作仅限宿主工作区");
      if (!ctx.pluginHost) throw new Error("插件宿主尚未就绪");
      const content = text(args.text);
      if (!content.trim() || content.length > 1024 * 1024) throw new Error("文本为空或超过 1 MiB");
      if (args.target === "notes")
        return ctx.pluginHost.manager.activate("spark233.notes", {
          commandId: "new",
          context: { kind: "text", text: content },
        });
      if (args.target === "dictionary") {
        const result = await ctx.pluginHost.manager.activate("spark233.translation", {
          commandId: "search",
          parameters: { action: "search", query: content, limit: 20 },
        });
        await ctx.showOfficialWorkspace("translation", result);
        return;
      }
      if (args.target === "translate") {
        if (
          !ctx.pluginHost.manager
            .list()
            .some(
              (record) =>
                record.pluginId === "spark233.translation" && record.enabled && !record.lastError,
            )
        )
          throw new Error("翻译插件已停用或不可用");
        await ctx.pluginHost.manager.activate("spark233.translation", {
          commandId: "status",
          parameters: { action: "config_status" },
        });
        await ctx.showOfficialWorkspace("translation", { kind: "translate-input", text: content });
        return;
      }
      throw new Error("未知文本动作");
    }
    if (command === "translation_action" || command === "translation_configure") {
      if (!ctx.isHostView(layout))
        throw new AppError("permissionDenied", "翻译设置和工作区仅限宿主界面");
      if (!ctx.pluginHost) throw new Error("插件宿主尚未就绪");
      if (command === "translation_configure")
        throw new AppError("obsoleteClient", "请在插件管理中保存翻译配置");
      if (args.action === "config_status") {
        const config = ctx.translationSettings();
        return {
          kind: "translation-config",
          configured: !!config.endpoint && !!config.model,
          endpoint: config.endpoint,
          model: config.model,
          hasKey: !!config.key,
        };
      }
      const actions: Record<string, string> = {
        search: "search",
        detail: "detail",
        translate: "translate",
        cancel: "cancel",
        config_status: "status",
        history_list: "history-list",
        history_delete: "history-delete",
        history_clear: "history-clear",
        preferences_get: "preferences-get",
        preferences_set: "preferences-set",
      };
      const action = text(args.action);
      if (!Object.hasOwn(actions, action)) throw new Error("未知翻译操作");
      if (
        action === "cancel" &&
        ctx.officialRenderers.get("spark233.translation")?.scope.state === "preparing"
      )
        return { cancelled: true };
      const result = await ctx.pluginHost.manager.activate("spark233.translation", {
        commandId: actions[action],
        parameters: { ...args, hostWorkspace: false },
      });
      // The workspace expects the business response, not its routing envelope.
      return result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        result.workspace === "translation"
        ? result.result
        : result;
    }
    if (command === "clipboard_action") {
      if (!ctx.isHostView(layout))
        throw new AppError("permissionDenied", "剪贴板工作区仅限宿主界面");
      if (!ctx.clipboardRuntime) throw new Error("剪贴板插件已停用或不可用");
      if (args.action === "open-quick") {
        z.strictObject({ action: z.literal("open-quick") }).parse(args);
        if (layout.pluginId !== "spark233.clipboard" || !ctx.pluginHost)
          throw new AppError("permissionDenied", "快捷剪贴板仅限剪贴板工作区打开");
        await ctx.pluginHost.manager.activate("spark233.clipboard", { commandId: "quick" });
        return;
      }
      return ctx.clipboardRuntime.request(args as ClipboardRequest);
    }
    if (command === "clipboard_image_ocr") {
      if (!ctx.isHostView(layout)) throw new AppError("permissionDenied", "图片动作仅限宿主工作区");
      if (!ctx.clipboardRuntime || !ctx.pluginHost) throw new Error("剪贴板插件不可用");
      if (
        !ctx.pluginHost.manager
          .list()
          .some(
            (record) => record.pluginId === "spark233.ocr" && record.enabled && !record.lastError,
          )
      )
        throw new Error("请先启用 OCR 插件");
      const source = await ctx.clipboardRuntime.imageResource(text(args.id));
      const image = nativeImage.createFromPath(source.path),
        size = image.getSize();
      if (image.isEmpty() || size.width * size.height > 100_000_000)
        throw new Error("剪贴板图片尺寸不受支持");
      const id = randomUUID(),
        filename = path.join(
          ctx.pluginHost.manager.dataDirectory("spark233.ocr"),
          "images",
          `${id}.png`,
        );
      atomicWrite(filename, image.toPNG());
      const resource = { id, kind: "image" as const, mimeType: "image/png" };
      ctx.pluginImages.set(id, {
        owner: ctx.clipboardRuntime.owner,
        sessionId: id,
        path: filename,
        resource,
        width: size.width,
        height: size.height,
      });
      return ctx.pluginHost.manager.activate("spark233.ocr", {
        commandId: "ocr",
        context: { kind: "image", resource },
      });
    }
    if (command === "screenshot_action") {
      if (!ctx.isHostView(layout)) throw new AppError("permissionDenied", "截图历史仅限宿主工作区");
      if (!ctx.pluginHost) throw new Error("插件宿主尚未就绪");
      const renderer = ctx.officialRenderers.get("spark233.screenshot");
      if (!renderer || renderer.scope.state !== "active") throw new Error("截图插件不可用");
      const history = new CaptureHistory(
        ctx.pluginHost.manager.dataDirectory("spark233.screenshot"),
      );
      const action = text(args.action);
      const resourceId = (entry: string) => `screenshot-history:${entry}`;
      if (action === "list")
        return history.list().map((entry) => {
          // The workspace renders history through the same resource protocol as
          // other plugin images, so each row needs a live handle while it is shown.
          const resource = {
            id: resourceId(entry.id),
            kind: "image" as const,
            mimeType: "image/png",
          };
          ctx.pluginImages.set(resource.id, {
            owner: renderer.scope.owner,
            sessionId: entry.id,
            path: history.file(entry.id),
            resource,
            width: entry.width,
            height: entry.height,
          });
          return { ...entry, resource };
        });
      if (action === "clear") {
        for (const entry of history.list()) ctx.pluginImages.delete(resourceId(entry.id));
        history.clear();
        return { cleared: true };
      }
      const id = text(args.id),
        file = history.file(id);
      if (!fs.existsSync(file)) throw new Error("这条截图已被清理");
      if (action === "remove") {
        const removed = history.remove(id);
        ctx.pluginImages.delete(resourceId(id));
        return { removed };
      }
      if (action === "copy") {
        // Electron 45 replaced the NativeImage clipboard API with ClipboardItem +
        // Blob payloads, so the stored PNG is committed as a single image entry.
        const png = fs.readFileSync(file);
        await clipboard.write([
          new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) }),
        ]);
        return { copied: true };
      }
      if (action === "save") {
        const chosen = await dialog.showSaveDialog({
          title: ctx.ui("保存截图", "Save screenshot"),
          defaultPath: ctx.ui("截图.png", "screenshot.png"),
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (chosen.canceled || !chosen.filePath) return { saved: false };
        fs.copyFileSync(file, chosen.filePath);
        return { saved: true, path: chosen.filePath };
      }
      // Recognizing a stored screenshot reuses the OCR plugin's image handoff, so
      // a retried recognition cannot leave a second copy in the history.
      if (
        !ctx.pluginHost.manager
          .list()
          .some(
            (record) => record.pluginId === "spark233.ocr" && record.enabled && !record.lastError,
          )
      )
        throw new Error("请先启用 OCR 插件");
      const image = nativeImage.createFromPath(file),
        size = image.getSize();
      if (image.isEmpty() || size.width * size.height > 100_000_000)
        throw new Error("截图尺寸不受支持");
      return ctx.pluginHost.manager.activate("spark233.ocr", {
        commandId: "ocr",
        context: { kind: "image", resource: { id: resourceId(id), kind: "image" } },
      });
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    clipboard_action: run,
    clipboard_image_ocr: run,
    screenshot_action: run,
    text_action: run,
    translation_action: run,
    translation_configure: run,
  } satisfies Record<string, CommandHandler>;
}
