import { clipboard, dialog, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError, atomicWrite, confined } from "../persistence.js";
import { type DesktopPluginHostOptions } from "../plugins/desktop-host.js";
import { resolvePluginEntries } from "../plugins/manifest.js";
import {
  clearApplicationIconCache,
  decorateApplicationResults,
  performIndexedApplicationAction,
} from "../plugins/official/applications.js";
import {
  createCaptureRuntime,
  createOcrRuntime,
  type CaptureImage,
} from "../plugins/official/capture.js";
import { createClipboardRuntime } from "../plugins/official/clipboard.js";
import { NotesDataClient } from "../plugins/official/notes-data-client.js";
import { createNotesRuntime } from "../plugins/official/notes.js";
import { createSearchRuntime } from "../plugins/official/search.js";
import type { RuntimeContext } from "../runtime.js";
export function createOfficialRuntimeFactory(
  ctx: Pick<
    RuntimeContext,
    | "launcherPresentationGuard"
    | "showMain"
    | "enqueueMutation"
    | "notesClient"
    | "changed"
    | "openNote"
    | "pluginImages"
    | "openNoteWithAnchor"
    | "ui"
    | "notesScope"
    | "notesRecoveryPending"
    | "windows"
    | "layouts"
    | "remember"
    | "preparedWindows"
    | "mutations"
    | "labelOf"
    | "prepare"
    | "persistLayout"
    | "pendingNotesMigration"
    | "notesActive"
    | "notesRendererRoot"
    | "notesStartupClient"
    | "notesMaintenanceClient"
    | "capsules"
    | "mcpServer"
    | "refreshTray"
    | "publishNoteStates"
    | "layoutsRestored"
    | "hostConfig"
    | "restoreNotesLayout"
    | "crashedWindows"
    | "tray"
    | "createWindow"
    | "syncMcp"
    | "bindOfficialRenderer"
    | "translationSettings"
    | "showOfficialWorkspace"
    | "pluginHost"
    | "configDir"
    | "diagnostics"
    | "privateDataRoots"
    | "emit"
    | "hideHostWindow"
    | "showClipboardWorkspace"
    | "clipboardRuntime"
    | "hostShutdown"
    | "exiting"
    | "requestLauncher"
  >,
): NonNullable<DesktopPluginHostOptions["createOfficialRuntime"]> {
  return async (installation, metadata, scope, backend, startupCheckOnly = false) => {
    const id = metadata.spark233.id;
    // The installed npm identity and its explicit native grant are both checked;
    // a Web page cannot select an adapter or supply an executable path.
    const expectedPackages: Record<string, string> = {
      "spark233.notes": "@spark233/plugin-notes",
      "spark233.applications": "@spark233/plugin-applications",
      "spark233.screenshot": "@spark233/plugin-screenshot",
      "spark233.ocr": "@spark233/plugin-ocr",
      "spark233.translation": "@spark233/plugin-translation",
      "spark233.search": "@spark233/plugin-search",
      "spark233.clipboard": "@spark233/plugin-clipboard",
    };
    if (!Object.hasOwn(expectedPackages, id) || metadata.name !== expectedPackages[id]) return;
    if (!installation.grant.native)
      throw new AppError("pluginTrustRequired", "官方原生适配需要已确认的执行权限");
    if (startupCheckOnly) {
      // Disabled updates validate the package/backend without attaching business
      // adapters: constructing the clipboard adapter would begin recording and
      // constructing notes would restore windows. The factory has already resolved
      // manifest paths and initialized any backend without sending activation.
      for (const descriptor of Object.values(metadata.spark233.native)) {
        const file = fs.openSync(confined(installation.directory, descriptor.path), "r");
        try {
          const signature = Buffer.alloc(2);
          if (fs.readSync(file, signature, 0, 2, 0) !== 2 || signature.toString("ascii") !== "MZ")
            throw new Error("Official native entry is not a Windows executable");
        } finally {
          fs.closeSync(file);
        }
      }
      return {
        activate: async () => {
          throw new AppError("pluginDisabled", "停用插件的启动校验不接受业务命令");
        },
      };
    }
    if (id === "spark233.notes") {
      if (!backend) throw new Error("Notes backend entry is required");
      let started = false;
      const renderer = confined(installation.directory, "renderer");
      if (!fs.statSync(confined(renderer, "index.html")).isFile())
        throw new Error("Notes renderer is missing from its package");
      const lifecycleData = NotesDataClient.fromTransport((activation) => {
        if (!scope.accepts(scope.owner))
          throw new AppError("pluginDisabled", "便签插件运行实例已失效");
        return backend.activate(activation);
      });
      const maintenanceData = NotesDataClient.fromTransport((activation) => {
        if (scope.state !== "preparing")
          throw new AppError("pluginStopping", "便签维护通道仅用于当前实例的最终保存");
        return backend.maintenance(activation);
      });
      return createNotesRuntime({
        scope,
        backend,
        openManager: () => {
          if (ctx.launcherPresentationGuard()()) ctx.showMain();
        },
        newNote: async (activation) => {
          if (activation.context?.kind === "text") {
            const note = await ctx.enqueueMutation(() =>
              ctx.notesClient.save({
                title: "",
                content: activation.context!.kind === "text" ? activation.context!.text : "",
                category: "",
              }),
            );
            ctx.changed();
            if (ctx.launcherPresentationGuard()()) await ctx.openNote(note.id);
          } else if (activation.context?.kind === "image") {
            const image = ctx.pluginImages.get(activation.context.resource.id);
            if (!image) throw new Error("图片资源已失效");
            // Snapshot the accepted input before it waits behind a host write or
            // maintenance. Closing the panel may revoke/delete its temporary file.
            const acceptedImage = fs.readFileSync(image.path).toString("base64");
            const note = await ctx.enqueueMutation(() =>
              ctx.notesClient.createFromImage(acceptedImage, "png"),
            );
            ctx.changed();
            if (ctx.launcherPresentationGuard()()) await ctx.openNote(note.id);
          } else if (ctx.launcherPresentationGuard()()) await ctx.openNote();
        },
        openNote: (id) => ctx.openNoteWithAnchor(id),
        showOnDesktop: async (id) => {
          await ctx.openNote(id);
        },
        search: async (query, signal) => ({
          items: (
            await (
              signal
                ? NotesDataClient.fromTransport((activation) =>
                    backend.activate(activation, signal),
                  )
                : ctx.notesClient
            ).search(query, 60)
          ).map((meta) => ({
            id: meta.id,
            title: meta.title || ctx.ui("无标题便签", "Untitled note"),
            description: meta.preview,
            commandId: "open-note",
            parameters: { id: meta.id },
            kind: "note",
            actions: [
              {
                title: ctx.ui("在便签管理器打开", "Open in note manager"),
                commandId: "open-note",
                parameters: { id: meta.id },
              },
              {
                title: ctx.ui("贴到桌面", "Show on desktop"),
                commandId: "desktop-note",
                parameters: { id: meta.id },
              },
            ],
          })),
        }),
        prepare: async (reason) => {
          if (reason === "crash" && !backend.running) {
            if (ctx.notesScope === scope) {
              ctx.notesRecoveryPending = true;
              for (const [label, win] of ctx.windows)
                if (ctx.layouts.get(label)?.view !== "launcher" && !win.isDestroyed())
                  ctx.remember(win);
            }
            // The failed utility cannot acknowledge another write. Release its
            // owner while retaining live renderer buffers for an explicit retry.
            return { ok: true };
          }
          // Failed construction owns no active note UI; do not ask retained
          // editors to save through a manager that has not registered this owner.
          if (!started) return { ok: true };
          for (const [label, win] of ctx.windows)
            if (ctx.layouts.get(label)?.view !== "launcher") ctx.preparedWindows.delete(win.id);
          await ctx.mutations.catch(() => {});
          const notes = [...ctx.windows.values()].filter(
            (win) => ctx.layouts.get(ctx.labelOf(win))?.view !== "launcher",
          );
          const saved = await Promise.all(notes.map(ctx.prepare));
          if (!saved.every(Boolean)) return { ok: false, reason: "便签尚未保存，已保留窗口和插件" };
          for (const win of notes) ctx.remember(win);
          await ctx.persistLayout(maintenanceData);
          if (ctx.pendingNotesMigration)
            ctx.pendingNotesMigration.copiedRoot = await maintenanceData.migrate(
              ctx.pendingNotesMigration.directory,
            );
          return { ok: true };
        },
        stop: () => {
          if (ctx.notesScope !== scope) return;
          ctx.notesActive = false;
          ctx.notesRendererRoot = undefined;
          if (ctx.notesScope === scope) {
            ctx.notesScope = undefined;
            ctx.notesStartupClient = undefined;
            ctx.notesMaintenanceClient = undefined;
          }
          ctx.capsules.setEnabled(false);
          ctx.mcpServer?.stop();
          if (!ctx.notesRecoveryPending)
            for (const [label, win] of ctx.windows)
              if (ctx.layouts.get(label)?.view !== "launcher") win.destroy();
          ctx.refreshTray();
          ctx.publishNoteStates();
        },
        start: async () => {
          ctx.layoutsRestored = false;
          await lifecycleData.initialize(ctx.hostConfig.value.locale);
          if (!ctx.notesRecoveryPending) await ctx.restoreNotesLayout(lifecycleData);
          ctx.layoutsRestored = true;
          ctx.notesScope = scope;
          ctx.notesStartupClient = lifecycleData;
          ctx.notesMaintenanceClient = maintenanceData;
          ctx.notesActive = true;
          ctx.notesRendererRoot = renderer;
          try {
            ctx.capsules.setEnabled(true);
            await ctx.capsules.refresh();
          } finally {
            ctx.notesStartupClient = undefined;
          }
          // A dead renderer has no buffer to preserve; keep its layout but let
          // normal window creation recreate it when recovering a utility owner.
          for (const [label, win] of ctx.windows)
            if (ctx.layouts.get(label)?.view !== "launcher" && ctx.crashedWindows.has(win.id))
              win.destroy();
          for (const layout of ctx.layouts.values())
            if (
              layout.view !== "launcher" &&
              layout.visible &&
              !layout.folded &&
              // Initial startup restores desktop notes; reopening the manager is
              // reserved for an explicit later enable or restore.
              (layout.noteId || (ctx.tray && layout.view === "main"))
            )
              ctx.createWindow(layout);
          for (const [label, win] of ctx.windows)
            if (ctx.layouts.get(label)?.view !== "launcher") ctx.preparedWindows.delete(win.id);
          await lifecycleData.startReminders();
          if (ctx.notesRecoveryPending) await ctx.persistLayout(lifecycleData);
          ctx.notesRecoveryPending = false;
          started = true;
          ctx.syncMcp();
          ctx.refreshTray();
        },
      });
    }
    if (id === "spark233.applications") {
      if (!backend) throw new Error("Applications backend entry is required");
      scope.own("event", { dispose: clearApplicationIconCache });
      return {
        query: async (activation, signal) => {
          const parameters =
            activation.parameters &&
            typeof activation.parameters === "object" &&
            !Array.isArray(activation.parameters)
              ? activation.parameters
              : {};
          const value = await backend.activate(
            { ...activation, parameters: { ...parameters, locale: ctx.hostConfig.value.locale } },
            signal,
          );
          signal?.throwIfAborted();
          const result = await decorateApplicationResults(value);
          signal?.throwIfAborted();
          return result;
        },
        activate: async (activation) => {
          const parameters =
            activation.parameters &&
            typeof activation.parameters === "object" &&
            !Array.isArray(activation.parameters)
              ? activation.parameters
              : {};
          const value = await backend.activate({
            ...activation,
            parameters: { ...parameters, locale: ctx.hostConfig.value.locale },
          });
          if (["launch", "reveal", "copy-path"].includes(activation.commandId ?? "")) {
            await performIndexedApplicationAction(value);
            return;
          }
          return decorateApplicationResults(value);
        },
      };
    }
    if (id === "spark233.translation") {
      if (!backend) throw new Error("Translation backend entry is required");
      ctx.bindOfficialRenderer(id, installation.directory, scope);
      return {
        query: (activation, signal) =>
          backend.activate(
            {
              ...activation,
              parameters: {
                ...(activation.parameters as Record<string, never>),
                hostConfiguration: ctx.translationSettings() as never,
              },
            },
            signal,
          ),
        activate: async (activation) => {
          // Executing Translate with text is explicit consent for this one
          // request. Merely matching or opening the workspace never sends it.
          if (activation.commandId === "translate" && !activation.parameters) {
            const text = activation.context?.kind === "text" ? activation.context.text : "";
            await ctx.showOfficialWorkspace("translation", {
              kind: "translate-input",
              text,
              ...(text.trim() ? { translateRequestId: randomUUID() } : {}),
            });
            return;
          }
          const result = await backend.activate({
            ...activation,
            parameters: {
              ...(activation.parameters as Record<string, never>),
              hostConfiguration: ctx.translationSettings() as never,
            },
          });
          const parameters =
            activation.parameters &&
            typeof activation.parameters === "object" &&
            !Array.isArray(activation.parameters)
              ? activation.parameters
              : {};
          if (activation.commandId === "detail" && parameters.hostWorkspace !== false)
            await ctx.showOfficialWorkspace("translation", result);
          return result;
        },
      };
    }
    const entries = resolvePluginEntries(installation.directory, metadata);
    const common = {
      scope,
      pluginRoot: installation.directory,
      dataDir: ctx.pluginHost!.manager.dataDirectory(id),
      cacheDir: path.join(ctx.configDir, "plugins", "cache", "runtime", id),
      approveTrust: () => installation.grant.native,
      onOutputBytes: (stream: "stdout" | "stderr", byteCount: number) => {
        if (scope.accepts(scope.owner))
          ctx.diagnostics?.output(scope.owner, stream, byteCount, "native");
      },
    };
    if (id === "spark233.search") {
      if (!entries.native.search) throw new Error("Search executable entry is required");
      // The workspace window loads this package's renderer. A package built
      // before the workspace existed keeps working in the launcher only.
      try {
        ctx.bindOfficialRenderer(id, installation.directory, scope);
      } catch (error) {
        if (
          !(
            installation.version === "0.1.0" &&
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT" &&
            "path" in error &&
            error.path === path.join(installation.directory, "renderer", "index.html")
          )
        )
          console.error("search-renderer", error);
      }
      const runtime = createSearchRuntime({
        ...common,
        descriptor: entries.native.search,
        getLocale: () => ctx.hostConfig.value.locale,
        privateRoots: () => ctx.privateDataRoots.list(),
        subscribePrivateRoots: (listener) => ctx.privateDataRoots.subscribe(listener),
        openPath: (filename) => shell.openPath(filename),
        revealPath: (filename) => {
          shell.showItemInFolder(filename);
        },
        copyPath: (filename) => {
          clipboard.writeText(filename);
        },
        confirmServiceAction: async (action) => {
          const english = ctx.hostConfig.value.locale.startsWith("en");
          const title =
            action === "configure"
              ? ctx.ui("修改文件索引范围", "Change file index scope")
              : action === "rebuild"
                ? ctx.ui("重建文件索引", "Rebuild file index")
                : ctx.ui("安装或更新文件搜索服务", "Install or update file search");
          const answer = await dialog.showMessageBox({
            type: "question",
            title,
            message:
              action !== "install"
                ? title
                : english
                  ? "Install or update the spark233 filename index service?"
                  : "安装或更新 spark233 文件名索引服务？",
            detail: english
              ? "Windows administrator approval is required. File contents are searched only when you query them."
              : "此操作会请求 Windows 管理员授权。正文只在你查询时按需搜索。",
            buttons: english ? ["Cancel", "Continue"] : ["取消", "继续"],
            defaultId: 0,
            cancelId: 0,
          });
          return answer.response === 1;
        },
      });
      return {
        query: runtime.query,
        activate: async (activation) => {
          // Entering the workspace does not run a query; the window asks for its
          // own results so the launcher session stays untouched.
          if (activation.commandId === "workspace") {
            await ctx.showOfficialWorkspace("search", {});
            return;
          }
          return runtime.activate(activation);
        },
      };
    }
    if (id === "spark233.clipboard") {
      if (!entries.native.clipboard) throw new Error("Clipboard executable entry is required");
      if (!backend) throw new Error("Clipboard backend entry is required");
      ctx.bindOfficialRenderer(id, installation.directory, scope);
      const runtime = await createClipboardRuntime({
        ...common,
        descriptor: entries.native.clipboard,
        backend,
        onChange: () => ctx.emit("clipboard-changed"),
        onError: (error) => console.error("clipboard-runtime", error.message),
        renderThumbnail: (bytes) => {
          const image = nativeImage.createFromBuffer(Buffer.from(bytes)),
            size = image.getSize();
          if (image.isEmpty() || size.width * size.height > 100_000_000)
            throw new Error("图片尺寸不受支持");
          const ratio = Math.min(1, 320 / Math.max(size.width, size.height));
          return image
            .resize({
              width: Math.max(1, Math.round(size.width * ratio)),
              height: Math.max(1, Math.round(size.height * ratio)),
              quality: "good",
            })
            .toPNG();
        },
        beforePaste: () => {
          for (const [label, win] of ctx.windows)
            if (
              ctx.layouts.get(label)?.view === "launcher" &&
              ctx.layouts.get(label)?.hostPage !== "settings"
            )
              ctx.hideHostWindow(win);
        },
        openWorkspace: async (presentation) => {
          await ctx.showClipboardWorkspace(presentation);
        },
        prepareWorkspace: async () => {
          const saved = await Promise.all(
            [...ctx.windows.values()]
              .filter((win) => ctx.layouts.get(ctx.labelOf(win))?.pluginId === id)
              .map(ctx.prepare),
          );
          return saved.every(Boolean)
            ? { ok: true }
            : { ok: false, reason: "剪贴板工作区草稿尚未保存" };
        },
        pickImages: async () => {
          const chosen = await dialog.showOpenDialog({
            title: ctx.hostConfig.value.locale.startsWith("en")
              ? "Import gallery images"
              : "导入图库图片",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }],
          });
          if (chosen.canceled) return [];
          return chosen.filePaths.slice(0, 100).map((filename) => {
            if (fs.statSync(filename).size > 32 * 1024 * 1024) throw new Error("图片超过 32 MiB");
            const image = nativeImage.createFromPath(filename),
              size = image.getSize();
            if (image.isEmpty() || size.width * size.height > 100_000_000)
              throw new Error("图片尺寸不受支持");
            return { name: path.basename(filename), png: image.toPNG() };
          });
        },
      });
      ctx.clipboardRuntime = runtime;
      scope.own("event", {
        dispose: () => {
          if (ctx.clipboardRuntime === runtime) ctx.clipboardRuntime = undefined;
          for (const [key, image] of ctx.pluginImages)
            if (image.owner.instanceId === scope.owner.instanceId) ctx.pluginImages.delete(key);
        },
      });
      return runtime;
    }
    if (id === "spark233.ocr") {
      if (!entries.native.ocr) throw new Error("OCR executable entry is required");
      ctx.bindOfficialRenderer(id, installation.directory, scope);
      const runtime = await createOcrRuntime({
        ...common,
        descriptor: entries.native.ocr,
        resolveImage: (resource) => {
          const image = ctx.pluginImages.get(resource.id);
          if (!image || resource.kind !== "image")
            throw new AppError("invalidResource", "图片资源已失效");
          return image.path;
        },
        onImage: (image) => {
          ctx.pluginImages.set(image.resource.id, image);
        },
        onImageReleased: (image) => {
          if (ctx.pluginImages.get(image.resource.id)?.path === image.path)
            ctx.pluginImages.delete(image.resource.id);
        },
        onResult: async (result) => {
          await ctx.showOfficialWorkspace("ocr", result);
        },
      });
      scope.own("event", {
        dispose: () => {
          for (const [key, image] of ctx.pluginImages)
            if (image.owner.instanceId === scope.owner.instanceId) ctx.pluginImages.delete(key);
        },
      });
      return {
        activate: async (activation) => {
          if (activation.commandId === "cancel") return runtime.activate(activation);
          if (!activation.context) {
            const chosen = await dialog.showOpenDialog({
              title: ctx.ui("选择需要取字的图片", "Choose an image for OCR"),
              properties: ["openFile"],
              filters: [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }],
            });
            if (chosen.canceled || !chosen.filePaths[0]) return;
            if (scope.state !== "active") throw new Error("OCR 插件正在停止");
            const filename = chosen.filePaths[0];
            if (fs.statSync(filename).size > 32 * 1024 * 1024) throw new Error("图片超过 32 MiB");
            const image = nativeImage.createFromPath(filename),
              size = image.getSize();
            if (image.isEmpty() || size.width * size.height > 100_000_000)
              throw new Error("图片尺寸不受支持");
            const id = randomUUID(),
              normalized = path.join(common.dataDir, "images", `${id}.png`);
            atomicWrite(normalized, image.toPNG());
            const imported: CaptureImage = {
              owner: scope.owner,
              sessionId: id,
              path: normalized,
              width: size.width,
              height: size.height,
              resource: { id, kind: "image", mimeType: "image/png" },
            };
            ctx.pluginImages.set(id, imported);
            return runtime.recognize(imported);
          }
          return runtime.activate(activation);
        },
      };
    }
    if (id === "spark233.screenshot") {
      if (!entries.native.capture) throw new Error("Screenshot executable entry is required");
      // An older package has no renderer build; capture must keep working there,
      // and only the history view reports that the plugin needs an update.
      try {
        ctx.bindOfficialRenderer(id, installation.directory, scope);
      } catch (error) {
        console.error("screenshot-renderer", error);
      }
      scope.own("event", {
        dispose: () => {
          for (const [key, image] of ctx.pluginImages)
            if (image.owner.instanceId === scope.owner.instanceId) ctx.pluginImages.delete(key);
        },
      });
      const runtime = await createCaptureRuntime({
        ...common,
        descriptor: entries.native.capture,
        getLocale: () => ctx.hostConfig.value.locale,
        getOcrStatus: () => ({
          available: !!ctx.pluginHost?.manager
            .list()
            .some(
              (record) => record.pluginId === "spark233.ocr" && record.enabled && !record.lastError,
            ),
          reason: "请先启用 OCR 插件",
        }),
        onResult: (image, action) => {
          ctx.pluginImages.set(image.resource.id, image);
          ctx.emit("screenshot-result", {
            resource: image.resource,
            width: image.width,
            height: image.height,
            action,
          });
        },
        recognize: async (image) => {
          ctx.pluginImages.set(image.resource.id, image);
          return ctx.pluginHost!.manager.activate("spark233.ocr", {
            commandId: "ocr",
            context: { kind: "image", resource: image.resource },
          });
        },
      });
      return {
        activate: async (activation) => {
          // The plugin entry opens history; the capture itself is an action.
          if (activation.commandId === "history") {
            await ctx.showOfficialWorkspace("screenshot-history", {});
            return;
          }
          if (activation.commandId !== "cancel") {
            const launcherWindow = ctx.windows.get("launcher");
            if (launcherWindow) ctx.hideHostWindow(launcherWindow);
          }
          try {
            return await runtime.activate(activation);
          } finally {
            if (!ctx.hostShutdown.isQuitting && !ctx.exiting && scope.state === "active")
              ctx.requestLauncher();
          }
        },
      };
    }
  };
}
