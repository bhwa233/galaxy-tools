import { clipboard, dialog, globalShortcut, Notification } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commandMatchesSourceApplication } from "@spark233/sdk";
import type {
  JsonValue,
  PluginManifest,
  PluginContext,
  PluginActivation,
  ResourceHandle,
} from "@spark233/sdk";
import { atomicWrite, canonical } from "../persistence.js";
import type { PluginManager } from "./manager.js";
import type { PluginResourceScope } from "./resources.js";
import type { PluginWebCapabilityRequest } from "./web-host.js";

const textPayload = z.strictObject({ text: z.string().max(1024 * 1024) });
const handlePayload = z.strictObject({ id: z.string().min(1).max(512) });

/** Electron supplies dialogs, clipboard, shortcuts and fetch. This broker only
 * binds those operations to a granted plugin instance and opaque file handles. */
export function createCapabilityBroker(options: {
  scope: PluginResourceScope;
  manifest: PluginManifest;
  manager: () => PluginManager;
  updateTray?: (payload: unknown) => void;
  resolveResource?: (resource: ResourceHandle) => string | undefined;
  invokeNative?: (
    entryId: string,
    activation: PluginActivation,
    signal: AbortSignal,
  ) => Promise<JsonValue | undefined>;
}) {
  const files = new Map<string, string>();
  const contextFiles = new Map<string, ResourceHandle>();
  const shortcuts = new Map<string, () => Promise<void>>();
  const notifications = new Set<Notification>();
  options.scope.own("event", {
    dispose: () => {
      files.clear();
      contextFiles.clear();
      for (const notification of notifications) notification.close();
      notifications.clear();
    },
  });
  const accept = (request: PluginWebCapabilityRequest) => {
    request.signal.throwIfAborted();
    if (options.scope.state !== "active" || !options.scope.accepts(request.owner))
      throw new Error("插件实例已失效或正在停止");
  };
  const selectedFile = (value: unknown) => {
    const { id } = handlePayload.parse(value),
      file = files.get(id);
    if (!file) throw new Error("文件资源不属于此插件实例或已失效");
    const contextResource = contextFiles.get(id);
    if (contextResource) {
      const current = options.resolveResource?.(contextResource);
      if (!current || canonical(current) !== file) {
        files.delete(id);
        contextFiles.delete(id);
        throw new Error("上下文文件资源已撤销，请重新选择");
      }
    }
    const real = canonical(file);
    if (real !== file || !fs.statSync(real).isFile())
      throw new Error("已授权文件发生变化，请重新选择");
    return real;
  };
  const broker = async (request: PluginWebCapabilityRequest): Promise<JsonValue | undefined> => {
    accept(request);
    const { capability, operation, payload } = request;
    if (capability === "tray" && operation === "update") {
      if (!options.updateTray) throw new Error("Plugin tray is unavailable");
      options.updateTray(payload);
      return;
    }
    if (capability === "native.process" && operation === "invoke") {
      const input = z
        .strictObject({
          entryId: z.string().min(1).max(80),
          commandId: z.string().min(1).max(80),
          parameters: z.json().optional(),
        })
        .parse(payload);
      if (
        !Object.hasOwn(options.manifest.native, input.entryId) ||
        !options.manifest.commands.some(
          (command) => command.id === input.commandId && !command.internal,
        )
      )
        throw new Error("原生调用只能使用本插件已声明的入口和公开命令");
      const command = options.manifest.commands.find((entry) => entry.id === input.commandId)!;
      // Raw capability payloads carry no host-observed source. Source-bound
      // commands must enter through the host's guarded activation route.
      if (!commandMatchesSourceApplication(command, undefined))
        throw new Error("此命令需要宿主确认的来源程序，请通过对应启动器动作执行");
      options.manager().assertCommandAvailable(options.manifest.id, input.commandId);
      if (!options.invokeNative) throw new Error("此插件的原生运行时不可用");
      return options.invokeNative(
        input.entryId,
        { commandId: input.commandId, parameters: input.parameters as JsonValue | undefined },
        request.signal,
      );
    }
    if (capability === "clipboard.read" && operation === "readText") return clipboard.readText();
    if (capability === "clipboard.write" && operation === "writeText") {
      clipboard.writeText(textPayload.parse(payload).text);
      return;
    }
    if (capability === "notifications" && operation === "show") {
      const input = z
        .strictObject({ title: z.string().min(1).max(160), body: z.string().max(4000).optional() })
        .parse(payload);
      if (!Notification.isSupported()) throw new Error("当前系统不支持通知");
      const notification = new Notification(input);
      notifications.add(notification);
      notification.once("close", () => notifications.delete(notification));
      notification.show();
      return;
    }
    if (capability === "shortcuts" && operation === "register") {
      const input = z
        .strictObject({
          accelerator: z.string().min(1).max(100),
          commandId: z.string().min(1).max(80),
        })
        .parse(payload);
      if (
        !options.manifest.commands.some(
          (command) => command.id === input.commandId && !command.internal,
        )
      )
        throw new Error("快捷键只能调用本插件已注册命令");
      if (shortcuts.has(input.accelerator)) return;
      if (
        !globalShortcut.register(input.accelerator, () => {
          if (options.scope.state === "active")
            void options
              .manager()
              .activate(options.scope.owner.pluginId, { commandId: input.commandId })
              .catch((error) => console.error("plugin-shortcut", error));
        })
      )
        throw new Error("快捷键已被占用");
      const release = options.scope.own("shortcut", {
        dispose: () => {
          globalShortcut.unregister(input.accelerator);
          shortcuts.delete(input.accelerator);
        },
      });
      shortcuts.set(input.accelerator, release);
      return;
    }
    if (capability === "shortcuts" && operation === "unregister") {
      const input = z.strictObject({ accelerator: z.string().max(100) }).parse(payload);
      await shortcuts.get(input.accelerator)?.();
      return;
    }
    if (capability === "files.read" && operation === "pick") {
      const input = z.strictObject({ multiple: z.boolean().optional() }).parse(payload ?? {});
      const picked = await dialog.showOpenDialog({
        title: `${options.manifest.displayName} — 选择文件`,
        properties: input.multiple ? ["openFile", "multiSelections"] : ["openFile"],
      });
      accept(request);
      if (picked.canceled) return [];
      return picked.filePaths.slice(0, 100).map((file) => {
        const real = canonical(file),
          id = randomUUID();
        files.set(id, real);
        return { id, kind: "file", size: fs.statSync(real).size, name: path.basename(real) };
      });
    }
    if (capability === "files.read" && ["readText", "readBytes"].includes(operation)) {
      const file = selectedFile(payload),
        size = fs.statSync(file).size;
      if (size > 8 * 1024 * 1024) throw new Error("文件超过 8 MiB 读取上限");
      return operation === "readText"
        ? fs.readFileSync(file, "utf8")
        : { base64: fs.readFileSync(file).toString("base64") };
    }
    if (capability === "files.write" && operation === "saveText") {
      const input = z
        .strictObject({
          text: z.string().max(8 * 1024 * 1024),
          name: z.string().max(160).optional(),
        })
        .parse(payload);
      const picked = await dialog.showSaveDialog({
        title: `${options.manifest.displayName} — 保存文件`,
        defaultPath: input.name ? path.basename(input.name) : undefined,
      });
      accept(request);
      if (picked.canceled || !picked.filePath) return;
      atomicWrite(picked.filePath, input.text);
      return;
    }
    if (capability === "network" && operation === "fetch") {
      const input = z
        .strictObject({
          url: z.url().max(4096),
          method: z.enum(["GET", "POST"]).default("GET"),
          headers: z.record(z.string(), z.string().max(8192)).optional(),
          body: z
            .string()
            .max(1024 * 1024)
            .optional(),
        })
        .parse(payload);
      const url = new URL(input.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Web 插件网络请求仅支持 HTTPS");
      const response = await fetch(url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: request.signal,
        redirect: "error",
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 4 * 1024 * 1024) throw new Error("网络响应超过 4 MiB");
          chunks.push(chunk.value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      accept(request);
      return {
        status: response.status,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: response.headers.get("content-type"),
      };
    }
    if (capability === "commands" && operation === "list")
      return options
        .manager()
        .commands()
        .map(({ pluginId, command }) => ({
          pluginId,
          id: command.id,
          title: command.title,
          inputs: command.inputs,
        }));
    if (capability === "commands" && operation === "execute") {
      const input = z
        .strictObject({
          pluginId: z.string().max(80),
          commandId: z.string().max(80),
          text: z
            .string()
            .max(1024 * 1024)
            .optional(),
        })
        .parse(payload);
      const target = options
        .manager()
        .commands()
        .find((entry) => entry.pluginId === input.pluginId && entry.command.id === input.commandId);
      if (!target) throw new Error("目标插件命令不可用");
      if (input.text !== undefined && !target.command.inputs.includes("text"))
        throw new Error("目标命令不接受文字");
      return options.manager().activate(input.pluginId, {
        commandId: input.commandId,
        ...(input.text !== undefined ? { context: { kind: "text", text: input.text } } : {}),
      });
    }
    throw new Error(`暂不支持此能力操作：${capability}/${operation}`);
  };
  return Object.assign(broker, {
    grantContext: (context?: PluginContext) => {
      // Expired references never become permanent picker grants. Prune on the
      // next grant as well as on read, bounding repeated panel captures.
      for (const [id, resource] of contextFiles) {
        const current = options.resolveResource?.(resource);
        if (!current || canonical(current) !== files.get(id)) {
          files.delete(id);
          contextFiles.delete(id);
        }
      }
      if (!context || context.kind === "text" || context.kind === "window") return;
      for (const resource of context.kind === "image" ? [context.resource] : context.resources) {
        const filename = options.resolveResource?.(resource);
        if (filename && (contextFiles.has(resource.id) || contextFiles.size < 256)) {
          files.set(resource.id, canonical(filename));
          contextFiles.set(resource.id, structuredClone(resource));
        }
      }
    },
    revokeContext: (ids: readonly string[]) => {
      for (const id of ids) if (contextFiles.delete(id)) files.delete(id);
    },
  });
}
