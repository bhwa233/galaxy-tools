import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  PluginActivation,
  PluginContext,
  PluginLauncherPage,
  PluginPackageMetadata,
  PluginTheme,
  ResourceHandle,
} from "@spark233/sdk";
import type { ManagedPluginRuntime } from "./manager.js";
import type { PluginResourceScope } from "./resources.js";
import type { UToolsDesktopHost } from "./utools-desktop.js";
import {
  compatibilityManifest,
  utoolsFeatureSchema,
  utoolsCommandId,
  type UToolsFeature,
} from "./utools-manifest.js";

interface Match {
  code: string;
  type: string;
  label: string;
  payload: unknown;
  mainPush: boolean;
}
interface Options {
  scope: PluginResourceScope;
  metadata: PluginPackageMetadata;
  directory: string;
  dataDir: string;
  cacheDir: string;
  hostVersion: string;
  getNativeId?: () => string;
  trusted: boolean;
  startupCheckOnly: boolean;
  show?: boolean;
  desktop?: UToolsDesktopHost;
  resolveResource?: (handle: ResourceHandle) => string | undefined;
  getTheme: () => PluginTheme;
  subscribeTheme?: (listener: () => void) => () => void;
  onCrash: (error: Error) => void;
  onDiagnostic?: (message: string) => void;
}
let matcher: Worker | undefined;
const matching = new Map<string, { finish: (error?: Error, matches?: Match[]) => void }>();
function resetMatcher(error: Error): void {
  const old = matcher;
  matcher = undefined;
  for (const pending of [...matching.values()]) pending.finish(error);
  void old?.terminate();
}
async function matchFeatures(
  features: UToolsFeature[],
  text: string,
  context: { type: string; payload: unknown },
  signal?: AbortSignal,
): Promise<Match[]> {
  signal?.throwIfAborted();
  // Share one bounded worker across plugins; typing must not create a process or
  // thread for every installed plugin. A stuck regex resets only this worker.
  if (!matcher) {
    const worker = new Worker(fileURLToPath(new URL("./utools-match-worker.cjs", import.meta.url)));
    matcher = worker;
    worker.unref();
    worker.on("message", (result) =>
      matching
        .get(result.id)
        ?.finish(result.error ? new Error(result.error) : undefined, result.matches),
    );
    worker.on("error", (error) => {
      if (matcher === worker)
        resetMatcher(error instanceof Error ? error : new Error(String(error)));
    });
    worker.on("exit", () => {
      if (matcher === worker) resetMatcher(new Error("匹配线程退出"));
    });
  }
  if (matching.size >= 128) throw new Error("uTools 匹配查询过多");
  const worker = matcher;
  worker.ref();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => resetMatcher(new Error("uTools 匹配规则超时")), 500);
    const abort = () => finish(new Error("查询取消"));
    const finish = (error?: Error, matches: Match[] = []) => {
      if (!matching.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!matching.size) worker.unref();
      if (error) reject(error);
      else resolve(matches);
    };
    matching.set(id, { finish });
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({ id, features, text, context });
  });
}

export function createUToolsRuntime(options: Options): ManagedPluginRuntime {
  if (!options.trusted) throw new Error("uTools 兼容插件需要显式信任完整代码执行");
  const manifest = compatibilityManifest(options.directory, options.metadata);
  const root = path.dirname(
    path.join(options.directory, options.metadata.spark233.compatibility!.manifest),
  );
  let child: ChildProcess | undefined,
    starting: Promise<void> | undefined,
    exited: Promise<void> | undefined;
  let stopped = false,
    expectedExit = false;
  const token = randomUUID();
  let desktopRequest: ((value: unknown) => Promise<unknown>) | undefined;
  const requests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const selections = new Map<
    string,
    { action: Record<string, unknown>; push: boolean; context?: PluginContext; expires: number }
  >();
  const features = (): UToolsFeature[] => {
    const filename = path.join(options.dataDir, "utools-features.json");
    const supported = (feature: UToolsFeature) =>
      !feature.platform || feature.platform.includes(process.platform as "win32");
    if (!fs.existsSync(filename)) return manifest.features.filter(supported);
    if (fs.statSync(filename).size > 256 * 1024) throw new Error("动态功能文件超过限制");
    const stored: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!Array.isArray(stored) || stored.length > 100) throw new Error("动态功能文件格式不合法");
    // Skip entries written by older runners instead of failing every feature.
    const dynamic = stored.flatMap((entry) => {
      const parsed = utoolsFeatureSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const merged = new Map(manifest.features.map((feature) => [feature.code, feature]));
    for (const feature of dynamic) merged.set(feature.code, feature);
    return [...merged.values()].filter(supported);
  };
  const rpc = (
    operation: string,
    value?: unknown,
    timeout = 15000,
    signal?: AbortSignal,
  ): Promise<any> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("查询取消"));
      if (!child?.connected) return reject(new Error("uTools 运行器已断开"));
      if (requests.size >= 64) return reject(new Error("uTools 请求过多"));
      const id = randomUUID();
      const finish = (failure?: Error, result?: unknown) => {
        requests.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else resolve(result);
      };
      const abort = () => finish(new Error("查询取消"));
      const timer = setTimeout(() => finish(new Error("uTools 请求超时: " + operation)), timeout);
      requests.set(id, {
        resolve: (result) => finish(undefined, result),
        reject: (error) => finish(error),
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.send({ id, token, operation, value }, (error) => {
        if (error) finish(error);
      });
    });
  const start = (): Promise<void> => {
    if (stopped || options.scope.state !== "active")
      throw new Error("uTools 插件已经停止或正在停用");
    return (starting ??= (async () => {
      fs.mkdirSync(options.cacheDir, { recursive: true });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      // Chromium only honours a profile path set before app ready, which the
      // runner reaches before init arrives. Hand it over at spawn time.
      env.SPARK233_UTOOLS_PROFILE = path.join(options.dataDir, "browser-profile");
      child = spawn(
        process.execPath,
        [...(app.isPackaged ? [] : [app.getAppPath()]), "--spark233-utools-runner"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env },
      );
      const running = child;
      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", (data) => options.onDiagnostic?.(String(data).slice(0, 2000)));
      exited = new Promise((resolve) => running.once("exit", () => resolve()));
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("uTools 运行器启动超时")), 10000);
        running.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        running.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("uTools 运行器提前退出"));
        });
        running.on("message", (message: any) => {
          if (message?.event === "ready" && !message.token) {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (message?.token !== token) return;
          if (message.event === "desktop-request") {
            void Promise.resolve()
              .then(() => {
                if (!desktopRequest) throw new Error("桌面插件层尚未就绪");
                return desktopRequest(message.value);
              })
              .then(
                (value) =>
                  running.connected &&
                  running.send({ token, event: "desktop-result", id: message.id, value }),
                (error) =>
                  running.connected &&
                  running.send({
                    token,
                    event: "desktop-result",
                    id: message.id,
                    error: String(error),
                  }),
              );
            return;
          }
          if (message.event === "diagnostic") options.onDiagnostic?.(String(message.message));
          if (message.event === "crash") options.onCrash(new Error(String(message.message)));
          const pending = requests.get(message.id);
          if (!pending) return;
          requests.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.value);
        });
      });
      running.once("exit", () => {
        const error = new Error("uTools 兼容运行器已退出");
        for (const pending of requests.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        requests.clear();
        if (!expectedExit) options.onCrash(error);
      });
      try {
        await ready;
        const result = await rpc("init", {
          token,
          pluginId: options.scope.owner.pluginId,
          manifest,
          pluginRoot: root,
          entryUrl: pathToFileURL(path.join(options.directory, options.metadata.spark233.entry!))
            .href,
          title: options.metadata.spark233.displayName,
          hostVersion: options.hostVersion,
          nativeId: options.getNativeId?.(),
          dataDir: options.dataDir,
          cacheDir: options.cacheDir,
          theme: options.getTheme(),
          show: options.show,
          desktopAvailable: !!options.desktop,
        });
        if (result?.ready !== true || result.pid !== running.pid)
          throw new Error("uTools 运行器 PID 握手不匹配");
      } catch (error) {
        expectedExit = true;
        running.kill();
        await exited;
        // A failed start must not stay cached: let the next activation retry.
        if (child === running) child = undefined;
        starting = undefined;
        if (!stopped) expectedExit = false;
        throw error;
      }
    })());
  };
  if (options.desktop && !options.startupCheckOnly)
    desktopRequest = options.desktop.attach(options.scope, options.metadata, async (value) => {
      if (value) await start();
      if (child?.connected) await rpc("desktop", value);
    });
  const contextFor = (
    context?: PluginContext,
    text = "",
    loadImage = true,
  ): { type: string; payload: unknown } => {
    if (context?.kind === "files")
      return {
        type: "files",
        payload: context.resources.map((resource) => {
          const file = options.resolveResource?.(resource);
          if (!file) throw new Error("文件上下文已失效");
          const stat = fs.statSync(file);
          return {
            name: path.basename(file),
            path: file,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
          };
        }),
      };
    if (context?.kind === "image") {
      const file = options.resolveResource?.(context.resource);
      if (!file || fs.statSync(file).size > 20 * 1024 * 1024)
        throw new Error("图片上下文失效或超过 20 MB");
      return {
        type: "img",
        payload: loadImage
          ? "data:image/png;base64," + fs.readFileSync(file).toString("base64")
          : true,
      };
    }
    return { type: "text", payload: context?.kind === "text" ? context.text : text };
  };
  const remember = (action: Record<string, unknown>, push: boolean, context?: PluginContext) => {
    const now = Date.now();
    for (const [id, item] of selections) if (item.expires < now) selections.delete(id);
    if (selections.size >= 256) selections.delete(selections.keys().next().value!);
    const id = randomUUID();
    const remembered = { ...action };
    // Keep resource handles, not a base64 image copy for every candidate/query.
    if (context && (action.type === "img" || action.type === "files")) delete remembered.payload;
    selections.set(id, { action: remembered, push, context, expires: now + 60000 });
    return id;
  };
  options.scope.own("process", {
    prepareStop: async (reason) => {
      await starting?.catch(() => undefined);
      if (!child || child.exitCode !== null) return { ok: true };
      return await rpc("prepare", reason, 120000);
    },
    cancelStop: async () => {
      if (child?.connected) await rpc("resume");
    },
    dispose: async () => {
      stopped = true;
      selections.clear();
      if (!child) return;
      expectedExit = true;
      if (child.connected) await rpc("stop", undefined, 10000);
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("uTools 进程尚未退出")), 10000);
          timer.unref();
        }),
      ]);
    },
    forceTerminate: async () => {
      stopped = true;
      expectedExit = true;
      child?.kill();
      await exited;
    },
  });
  if (options.subscribeTheme) {
    const unsubscribe = options.subscribeTheme(() => {
      if (child?.connected)
        void rpc("theme", options.getTheme()).catch((error) =>
          options.onDiagnostic?.(String(error)),
        );
    });
    options.scope.own("event", { dispose: unsubscribe });
  }
  return {
    async activate(activation: PluginActivation) {
      if (options.startupCheckOnly || !activation.commandId) return;
      const parameters = activation.parameters as Record<string, unknown> | undefined;
      let action: Record<string, unknown>,
        push = false;
      if (activation.commandId === "compat-dispatch") {
        const id = String(parameters?.utoolsSelection || "");
        const selection = selections.get(id);
        selections.delete(id);
        if (!selection || selection.expires < Date.now())
          throw new Error("查询结果已过期，请重新搜索");
        action = selection.action;
        if (selection.context) {
          const resolved = contextFor(selection.context, "", action.type === "img");
          if (action.type === "img" || action.type === "files")
            action = { ...action, payload: resolved.payload };
        }
        push = selection.push;
        if (!features().some((feature) => feature.code === action.code))
          throw new Error("功能已删除");
      } else {
        const feature = features().find((f) => utoolsCommandId(f.code) === activation.commandId);
        if (!feature) throw new Error("uTools 功能不存在");
        const context = contextFor(activation.context);
        action = {
          code: feature.code,
          type: activation.context ? context.type : "text",
          payload: activation.context
            ? context.payload
            : feature.cmds.find((cmd) => typeof cmd === "string") || feature.code,
          from: "main",
        };
      }
      await start();
      await rpc(
        push ? "select" : "activate",
        push
          ? action
          : {
              ...action,
              // A launcher entry without input only reveals an existing desktop
              // editor. Matched text/files/images are always a fresh activation.
              revealOnly: activation.commandId !== "compat-dispatch" && !activation.context,
            },
      );
      return undefined;
    },
    async query(activation, signal) {
      if (options.startupCheckOnly) return { items: [] };
      const parameters = activation.parameters as Record<string, unknown> | undefined;
      const text = String(parameters?.query || "").slice(0, 100000);
      const context = contextFor(activation.context, text, false);
      const matches = await matchFeatures(features(), text, context, signal);
      signal?.throwIfAborted();
      const page: PluginLauncherPage = { items: [] };
      const seen = new Set<string>();
      for (const match of matches) {
        const key = match.code + ":" + match.type + ":" + match.label;
        if (seen.has(key)) continue;
        seen.add(key);
        const action = { code: match.code, type: match.type, payload: match.payload, from: "main" };
        if (match.mainPush) {
          if (match.type === "img") action.payload = contextFor(activation.context, text).payload;
          await start();
          const rows = await rpc("query", action, 15000, signal);
          signal?.throwIfAborted();
          if (!Array.isArray(rows) || Buffer.byteLength(JSON.stringify(rows)) > 256 * 1024)
            throw new Error("插件搜索结果超过限制");
          for (const [index, row] of rows.slice(0, 100 - page.items.length).entries()) {
            const id = remember({ ...action, option: row }, true, activation.context);
            page.items.push({
              id: match.code + ":" + index,
              title: String(row.title || row.text || match.label).slice(0, 1000),
              description: String(row.text || "").slice(0, 4000),
              commandId: "compat-dispatch",
              parameters: { utoolsSelection: id },
            });
          }
        } else if (match.type !== "text") {
          const id = remember(action, false, activation.context);
          page.items.push({
            id: key,
            title: match.label,
            commandId: "compat-dispatch",
            parameters: { utoolsSelection: id },
          });
        } else if (!manifest.features.some((f) => f.code === match.code)) {
          const id = remember(action, false, activation.context);
          page.items.push({
            id: key,
            title: match.label,
            commandId: "compat-dispatch",
            parameters: { utoolsSelection: id },
          });
        }
        if (page.items.length >= 100) break;
      }
      return page as unknown as import("@spark233/sdk").JsonValue;
    },
  };
}
