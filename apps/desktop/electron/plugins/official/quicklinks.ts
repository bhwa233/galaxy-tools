import { dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  JsonValue,
  PluginActivation,
  PluginPackageMetadata,
  PluginTheme,
} from "@spark233/sdk";
import { AppError, confined } from "../../persistence.js";
import type { PluginBackendController } from "../backend.js";
import { createCapabilityBroker } from "../capabilities.js";
import type { ManagedPluginRuntime, PluginInstallation, PluginManager } from "../manager.js";
import type { PluginResourceScope } from "../resources.js";
import { createWebPluginRuntime, type WebPluginController } from "../web-host.js";
import { performIndexedApplicationAction } from "./applications.js";

const parametersSchema = z.strictObject({
  id: z.string().min(1).max(100),
  entryRevision: z.string().min(1).max(128).optional(),
  query: z.string().max(4096).optional(),
  values: z.record(z.string().min(1).max(80), z.string().max(4096)).optional(),
});
const resolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    entry: z.record(z.string(), z.json()),
    entryRevision: z.string().min(1).max(128),
    query: z.string().max(4096),
    fields: z.array(z.string().min(1).max(80)).max(32),
    values: z.record(z.string().max(80), z.string().max(4096)),
  }),
  z.strictObject({ kind: z.literal("url"), url: z.string().min(1).max(16384) }),
  z.strictObject({
    kind: z.literal("program"),
    path: z.string().min(1).max(32768),
    args: z.array(z.string().max(4096)).max(64),
    cwd: z.string().max(32768),
  }),
]);
const urlProtocols = new Set([
  "http:",
  "https:",
  "vscode:",
  "vscode-insiders:",
  "obsidian:",
  "notion:",
  "zotero:",
  "mailto:",
]);
const configurationCommands = new Set(["settings.get", "settings.save", "resolve"]);

interface QuicklinksRuntimeOptions {
  installation: PluginInstallation;
  metadata: PluginPackageMetadata;
  scope: PluginResourceScope;
  backend: PluginBackendController;
  manager: PluginManager;
  getLocale: () => string;
  getTheme: () => PluginTheme;
  subscribeTheme: (listener: () => void) => () => void;
}

/** Reuse the sandboxed plugin web host, capability broker and indexed application
 * executor. This adapter only resolves saved entry IDs and admits URL schemes;
 * neither searches nor renderer backend calls can directly open external targets. */
export function createQuicklinksRuntime(options: QuicklinksRuntimeOptions): ManagedPluginRuntime {
  const { scope, backend, metadata, installation, manager } = options;
  let web: Promise<WebPluginController> | undefined;
  const assertActive = () => {
    if (scope.state !== "active" || !manager.isOwnerCurrent(scope.owner))
      throw new AppError("pluginDisabled", "快捷搜索插件实例已失效或正在停止");
  };
  const broker = createCapabilityBroker({
    scope,
    manifest: metadata.spark233,
    manager: () => manager,
    backendJsonLimits: { maxBytes: 256 * 1024, maxNodes: 16384, maxStringLength: 32768 },
    invokeBackend: (activation, signal) => {
      if (!configurationCommands.has(activation.commandId ?? ""))
        throw new AppError("permissionDenied", "此通道仅允许管理和预览快捷入口");
      return backend.activate(activation, signal);
    },
  });
  const workspace = async (activation: PluginActivation) => {
    assertActive();
    if (!web) {
      const profile = metadata.spark233.ui?.windows?.main;
      if (!profile) throw new Error("Quicklinks workspace window is not declared");
      const opening = createWebPluginRuntime({
        scope,
        pluginRoot: installation.directory,
        entryPath: confined(installation.directory, profile.entry),
        windowProfile: "main",
        manifest: metadata.spark233,
        dataDir: manager.dataDirectory(metadata.spark233.id),
        grant: installation.grant,
        getLocale: options.getLocale,
        getTheme: options.getTheme,
        subscribeTheme: options.subscribeTheme,
        capabilityBroker: broker,
        onCrash: (error) => {
          void manager
            .reportCrash(scope.owner, error)
            .catch((failure) => console.error("quicklinks-renderer-crash", failure));
        },
      });
      web = opening;
      void opening.catch(() => {
        if (web === opening) web = undefined;
      });
    }
    const controller = await web;
    assertActive();
    await controller.checkStartup();
    assertActive();
    await controller.activate({ ...activation, commandId: "workspace" });
  };
  const run = async (activation: PluginActivation): Promise<JsonValue> => {
    // commands.execute carries text, while launcher actions retain parameters.
    // Parse only entry identity and variable input; targets always come from the
    // trusted backend's current persisted definition and revision check.
    const input = parametersSchema.parse(
      activation.parameters ??
        (activation.context?.kind === "text" ? JSON.parse(activation.context.text) : undefined),
    );
    const result = resolutionSchema.parse(
      await backend.activate({ commandId: "resolve", parameters: input }),
    );
    assertActive();
    if (result.kind === "prompt") {
      await workspace({ commandId: "workspace", parameters: result });
      return { prompt: true };
    }
    if (result.kind === "url") {
      const url = new URL(result.url);
      if (
        /\p{Cc}/u.test(result.url) ||
        !urlProtocols.has(url.protocol) ||
        url.username ||
        url.password
      )
        throw new AppError("permissionDenied", "快捷入口链接协议或内容不受支持");
      assertActive();
      await shell.openExternal(url.href);
    } else {
      if (!path.isAbsolute(result.path) || !/\.exe$/i.test(result.path))
        throw new AppError("invalidApplication", "参数化快开需要已保存的 EXE 程序");
      const real = fs.realpathSync(result.path);
      if (!/\.exe$/i.test(real))
        throw new AppError("invalidApplication", "参数化快开程序目标已改变");
      assertActive();
      await performIndexedApplicationAction({
        action: "launchApplication",
        target: { kind: "custom", path: result.path, args: result.args, cwd: result.cwd },
      });
    }
    assertActive();
    return { ok: true };
  };
  return {
    query: (activation, signal) => {
      assertActive();
      if (activation.commandId !== "search")
        throw new AppError("unknownPluginCommand", "快捷入口查询仅允许搜索命令");
      return backend.activate(activation, signal);
    },
    activate: async (activation) => {
      assertActive();
      const commandId = activation.commandId ?? "workspace";
      if (commandId === "workspace" || (commandId === "search" && !activation.parameters)) {
        await workspace(activation);
        return;
      }
      if (commandId === "run") return run(activation);
      if (commandId === "pick-program") {
        const controller = web ? await web : undefined;
        assertActive();
        const dialogOptions = {
          title: options.getLocale().startsWith("en") ? "Select a program" : "选择程序",
          properties: ["openFile"] as Array<"openFile">,
          filters: [{ name: "Windows program", extensions: ["exe"] }],
        };
        const picked = controller?.window
          ? await dialog.showOpenDialog(controller.window, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        assertActive();
        if (picked.canceled || !picked.filePaths[0]) return;
        const filename = fs.realpathSync(picked.filePaths[0]);
        if (!/\.exe$/i.test(filename) || !fs.statSync(filename).isFile())
          throw new AppError("invalidApplication", "请选择有效的 EXE 程序");
        return { path: filename };
      }
      if (commandId === "search" || configurationCommands.has(commandId))
        return backend.activate({ ...activation, commandId });
      throw new AppError("unknownPluginCommand", "快捷入口命令不可用");
    },
  };
}
