import { settingsSchema, validateSettings } from "./search-settings.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonValue, PluginActivation } from "@spark233/sdk";
import { atomicWrite, canonical, confined, inside } from "../../persistence.js";
import { createTrustedNativeProcess, type PluginNativeController } from "../backend.js";
import type { ManagedPluginRuntime } from "../manager.js";
import { PluginResourceScope, type StopDecision } from "../resources.js";

export interface SearchRuntimeOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  descriptor: { path: string; args: string[] };
  dataDir: string;
  cacheDir: string;
  approveTrust: () => boolean | Promise<boolean>;
  onOutputBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  privateRoots?: readonly string[] | (() => readonly string[]);
  subscribePrivateRoots?: (listener: () => Promise<void>) => () => void;
  getLocale?: () => string;
  openPath: (filename: string) => Promise<string | void>;
  revealPath?: (filename: string) => void | Promise<void>;
  copyPath?: (filename: string) => void | Promise<void>;
  confirmServiceAction: (action: "install" | "configure" | "rebuild") => Promise<boolean>;
  /** Host-only isolated integration scope. Never sourced from activation input. */
  fixture?: { pipeName: string; roots: string[]; beforePublish?: () => void };
}

const responseSchema = z.object({
  protocol: z.literal(1),
  sessionId: z.string(),
  owner: z.object({ pluginId: z.string(), version: z.string(), instanceId: z.string() }),
  status: z.enum([
    "ok",
    "cancelled",
    "service-not-installed",
    "service-update-required",
    "service-unavailable",
    "authorization-denied",
    "error",
  ]),
  error: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  revision: z.string().optional(),
  hasMore: z.boolean().optional(),
  service: z
    .object({
      connected: z.boolean(),
      message: z.string(),
      excludedRoots: z.array(z.string()),
      effectiveExcludedRoots: z.array(z.string()),
      volumes: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          mountPoint: z.string(),
          fileSystem: z.string(),
          online: z.boolean(),
          supported: z.boolean(),
          enabled: z.boolean(),
          indexedItems: z.number(),
          progress: z.number(),
          state: z.string(),
          error: z.string(),
        }),
      ),
    })
    .optional(),
  hits: z
    .array(
      z.object({
        path: z.string().max(32768),
        name: z.string().max(32768),
        directory: z.boolean(),
        snippet: z.string().max(32768).optional(),
        line: z.number().int().nonnegative().optional(),
        fileId: z
          .string()
          .regex(/^\d{1,20}$/)
          .optional(),
        size: z
          .string()
          .regex(/^\d{1,20}$/)
          .optional(),
        modified: z
          .string()
          .regex(/^\d{1,20}$/)
          .optional(),
        fileVersion: z
          .string()
          .regex(/^\d{1,10}:\d{1,10}:\d{1,10}:\d{1,20}$/)
          .optional(),
      }),
    )
    .max(200),
});
type Query = {
  mode: "files" | "content";
  query: string;
  directory: string;
  offset: number;
  limit: number;
  revision?: string;
};
type Session = {
  id: string;
  directory: string;
  scope: PluginResourceScope;
  process?: PluginNativeController;
  cancelled: boolean;
  done: Promise<void>;
  finish: () => void;
};

export function createSearchRuntime(options: SearchRuntimeOptions): ManagedPluginRuntime {
  const ui = (zh: string, en: string) => (options.getLocale?.().startsWith("en") ? en : zh);
  const root = canonical(options.pluginRoot);
  const executable = canonical(options.descriptor.path);
  if (
    !path.isAbsolute(options.descriptor.path) ||
    !inside(root, executable) ||
    options.descriptor.args.length
  )
    throw new Error(
      "Official search entry must be a package executable with host-controlled arguments",
    );
  for (const directory of [options.dataDir, options.cacheDir]) {
    if (!path.isAbsolute(directory)) throw new Error("Search data/cache must be absolute");
    fs.mkdirSync(directory, { recursive: true });
    if (inside(root, canonical(directory)))
      throw new Error("Search mutable data must be outside its package");
  }
  if (
    options.fixture &&
    (!options.fixture.pipeName.startsWith("\\\\.\\pipe\\spark233Index.Test.") ||
      !options.fixture.roots.length ||
      options.fixture.roots.some((value) => !path.isAbsolute(value)))
  )
    throw new Error("Invalid isolated search scope");
  type CallerState = {
    id: string;
    generation: number;
    current?: Session;
    selections: Map<
      string,
      { path: string; line: number; snippet: string; version?: ContentVersion }
    >;
    cursors: Map<string, { query: Query; generation: number }>;
    lastQuery?: Query;
    scopeSignal?: AbortSignal;
    detachSignal?: () => void;
  };
  const callers = new Map<string, CallerState>();
  const sessions = new Set<Session>();
  let generation = 0;
  let disposed = false;
  function caller(parameters: Record<string, JsonValue>): CallerState {
    const id = parameters.callerId ?? "legacy";
    if (
      typeof id !== "string" ||
      !id.length ||
      id.length > 200 ||
      [...id].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error("Invalid search caller identity");
    let state = callers.get(id);
    if (!state) {
      state = { id, generation: 0, selections: new Map(), cursors: new Map() };
      callers.set(id, state);
    }
    return state;
  }
  function expireCaller(state: CallerState): void {
    ++state.generation;
    state.selections.clear();
    state.cursors.clear();
    state.lastQuery = undefined;
    state.detachSignal?.();
    if (callers.get(state.id) === state) callers.delete(state.id);
    if (state.current) requestCancel(state.current);
  }
  function bindCallerSignal(state: CallerState, signal: AbortSignal): void {
    state.detachSignal?.();
    const abort = () => {
      if (callers.get(state.id) === state) expireCaller(state);
    };
    state.scopeSignal = signal;
    state.detachSignal = () => {
      signal.removeEventListener("abort", abort);
      state.detachSignal = undefined;
      state.scopeSignal = undefined;
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  function revokeAll(): void {
    ++generation;
    for (const state of callers.values()) expireCaller(state);
  }
  let control = Promise.resolve();
  const settingsFile = confined(options.dataDir, "search-scope.json");
  let settings = fs.existsSync(settingsFile)
    ? validateSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8")))
    : settingsSchema.parse({ excludedRoots: [] });
  function excludedRoots(): string[] {
    return [
      ...new Set(
        [
          ...(typeof options.privateRoots === "function"
            ? options.privateRoots()
            : (options.privateRoots ?? [])),
          options.dataDir,
          options.cacheDir,
          ...settings.excludedRoots,
        ].flatMap((value) => [path.resolve(value), canonical(value)]),
      ),
    ];
  }

  function assertActive(): void {
    if (disposed || options.scope.state !== "active") throw new Error("Search plugin is disabled");
  }
  type ContentVersion = {
    id: string;
    volume: bigint;
    size: string;
    modified: string;
    changed: bigint;
  };
  // Reuse Node's bigint stat identity and Pulse's read-handle version; never
  // establish the baseline from a later stat of a path containing an old hit.
  function sameVersion(metadata: fs.BigIntStats, version: ContentVersion): boolean {
    const epoch = 116444736000000000n;
    return (
      metadata.isFile() &&
      metadata.ino === BigInt(version.id) &&
      metadata.dev === version.volume &&
      metadata.size === BigInt(version.size) &&
      metadata.mtimeNs === (BigInt(version.modified) - epoch) * 100n &&
      metadata.ctimeNs === (version.changed - epoch) * 100n
    );
  }
  function currentVersion(filename: string, version: ContentVersion): boolean {
    try {
      return sameVersion(fs.lstatSync(filename, { bigint: true }), version);
    } catch {
      return false;
    }
  }
  function requestCancel(session: Session): void {
    session.cancelled = true;
    atomicWrite(confined(session.directory, "cancel.request"), session.id);
  }
  async function cancel(session?: Session): Promise<StopDecision> {
    if (!session) return { ok: true };
    requestCancel(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      session.done.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 15000);
      }),
    ]);
    clearTimeout(timer);
    return exited
      ? { ok: true }
      : { ok: false, reason: "Search cancellation pending; native process remains tracked" };
  }
  async function cancelAll(): Promise<StopDecision> {
    const decisions = await Promise.all([...sessions].map((session) => cancel(session)));
    return decisions.find((decision) => !decision.ok) ?? { ok: true };
  }
  function serialize<T>(callback: () => Promise<T>): Promise<T> {
    const result = control.then(callback);
    control = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function finishSession(session: Session, state?: CallerState): Promise<void> {
    if (session.process) {
      const released = await session.scope.stop("quit");
      if (!released.ok) throw new Error(released.errors.join("; "));
    }
    try {
      fs.rmSync(session.directory, { recursive: true, force: true });
    } finally {
      if (state?.current === session) state.current = undefined;
      sessions.delete(session);
      session.finish();
    }
  }
  async function native(
    query: Query | undefined,
    action: "search" | "install" | "service-status" | "service-configure" | "service-rebuild",
    requestGeneration: number,
    serviceParameters?: {
      serviceExcludedRoots: string[];
      enabledVolumeIds: string[];
      disabledVolumeIds: string[];
    },
    state?: CallerState,
    signal?: AbortSignal,
  ) {
    const epoch = generation;
    const stale = () =>
      signal?.aborted || epoch !== generation || (state && requestGeneration !== state.generation);
    const statusOnly = action === "service-status";
    // Serialize only replacement/start. Holding this lock until completion would
    // prevent a newer query from cancelling a slow content search.
    const session = await serialize(async () => {
      assertActive();
      if (stale()) return;
      if (!statusOnly) {
        const stopped = await (state ? cancel(state.current) : cancelAll());
        if (!stopped.ok) throw new Error(stopped.reason);
      }
      assertActive();
      if (stale()) return;
      const id = randomUUID();
      const directory = confined(options.cacheDir, `sessions/${id}`);
      fs.mkdirSync(directory, { recursive: true });
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const created: Session = {
        id,
        directory,
        scope: new PluginResourceScope(options.scope.owner),
        cancelled: false,
        done,
        finish,
      };
      atomicWrite(
        confined(directory, "request.json"),
        JSON.stringify({
          protocol: 1,
          sessionId: id,
          owner: options.scope.owner,
          action,
          ...query,
          profile: options.dataDir,
          // Only host-owned roots and the validated persisted user setting enter
          // the native admission filter; activation parameters cannot override it.
          privateRoots: excludedRoots(),
          extensions: settings.extensions,
          maxFileMiB: settings.maxFileMiB,
          includeHidden: settings.includeHidden,
          ...serviceParameters,
          ...(options.fixture
            ? { fixturePipe: options.fixture.pipeName, fixtureRoots: options.fixture.roots }
            : {}),
        }),
      );
      sessions.add(created);
      if (state) state.current = created;
      return created;
    });
    if (!session) return;
    const abort = () => requestCancel(session);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      session.process = await createTrustedNativeProcess({
        scope: session.scope,
        pluginRoot: root,
        descriptor: {
          path: executable,
          args: ["--request", confined(session.directory, "request.json")],
        },
        approveTrust: options.approveTrust,
        onOutputBytes: options.onOutputBytes,
        prepareStop: async () => {
          requestCancel(session);
          return { ok: true };
        },
        requestShutdown: () => requestCancel(session),
        timeoutMs: 15000,
      });
      const exit = await session.process.waitForExit();
      if (exit.error || exit.code !== 0)
        throw new Error(exit.error ?? `Search helper exited (${exit.code})`);
      if (session.cancelled || stale() || !options.scope.accepts(options.scope.owner)) return;
      const filename = confined(session.directory, "result.json");
      if (!fs.existsSync(filename) || fs.statSync(filename).size > 8 * 1024 * 1024)
        throw new Error(`Search helper did not produce a bounded result (${JSON.stringify(exit)})`);
      const result = responseSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
      if (
        result.sessionId !== session.id ||
        Object.keys(options.scope.owner).some(
          (key) =>
            result.owner[key as keyof typeof result.owner] !==
            options.scope.owner[key as keyof typeof options.scope.owner],
        )
      )
        throw new Error("Search helper returned a stale owner/session");
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      await finishSession(session, state);
    }
  }
  function info(
    title: string,
    description: string,
    commandId: string = "install-service",
  ): JsonValue {
    return { items: [{ id: randomUUID(), title, description, commandId, parameters: {} }] };
  }
  async function search(
    query: Query,
    state: CallerState,
    signal?: AbortSignal,
    append = false,
  ): Promise<JsonValue | undefined> {
    if (!append && signal) bindCallerSignal(state, signal);
    signal?.throwIfAborted();
    const mine = ++state.generation;
    // Paging extends one query snapshot; only new input revokes earlier hits.
    if (!append) state.selections.clear();
    state.cursors.clear();
    state.lastQuery = query;
    if (!query.query.trim()) {
      await cancel(state.current);
      return { items: [] };
    }
    const result = await native(query, "search", mine, undefined, state, signal);
    if (signal?.aborted || mine !== state.generation) return;
    if (!result || result.status === "cancelled") return;
    if (result.status === "service-not-installed")
      return info(
        "安装文件搜索服务",
        "需要管理员确认；安装后使用 Pulse 默认 NTFS 卷与排除项。点击安装或重试。",
      );
    if (result.status === "service-update-required")
      return info(
        "更新文件搜索服务",
        "搜索插件包含新服务版本。确认后通过 Windows 管理员授权切换；不会在普通查询时自动升级。",
      );
    if (result.status !== "ok")
      return info(
        "搜索暂时不可用，点击重试",
        result.message ?? `Windows error ${result.error ?? 0}`,
        query.mode === "content" ? "content" : "search",
      );
    if (query.revision && query.revision !== result.revision)
      return info(
        "文件索引已更新，点击重新搜索",
        "旧分页已失效。",
        query.mode === "content" ? "content" : "search",
      );
    const items: JsonValue[] = [];
    options.fixture?.beforePublish?.();
    if (signal?.aborted || mine !== state.generation) return;
    const excluded = excludedRoots();
    for (const hit of result.hits) {
      if (!path.isAbsolute(hit.path)) throw new Error("Search returned a non-absolute path");
      const resolved = canonical(hit.path);
      if (excluded.some((root) => inside(root, hit.path) || inside(root, resolved))) continue;
      const id = randomUUID();
      let version: ContentVersion | undefined;
      if (query.mode === "content") {
        if (!hit.fileId || !hit.size || !hit.modified || !hit.fileVersion) continue;
        const [volume, high, low, changed] = hit.fileVersion.split(":").map(BigInt);
        if (((high << 32n) | low) !== BigInt(hit.fileId)) continue;
        version = { id: hit.fileId, volume, size: hit.size, modified: hit.modified, changed };
        if (!currentVersion(hit.path, version)) continue;
      }
      state.selections.set(id, {
        path: hit.path,
        line: hit.line ?? 0,
        snippet: hit.snippet ?? "",
        version,
      });
      items.push({
        id,
        title: hit.name,
        description: hit.snippet ? `${hit.path}:${hit.line ?? 0} · ${hit.snippet}` : hit.path,
        kind: hit.directory ? "directory" : "file",
        commandId: "open",
        parameters: { selection: id, callerId: state.id },
        actions: [
          {
            title: ui("打开所在位置", "Show location"),
            commandId: "reveal",
            parameters: { selection: id, callerId: state.id },
          },
          {
            title: ui("复制路径", "Copy path"),
            commandId: "copy-path",
            parameters: { selection: id, callerId: state.id },
          },
          ...(!hit.directory && hit.snippet
            ? [
                {
                  title: ui("预览并定位命中行", "Preview matching line"),
                  commandId: "preview",
                  parameters: { selection: id, callerId: state.id },
                },
              ]
            : []),
        ],
      });
    }
    if (result.hasMore) {
      const cursor = randomUUID();
      state.cursors.set(cursor, {
        generation: mine,
        query: { ...query, offset: query.offset + query.limit, revision: result.revision },
      });
      items.push({
        id: cursor,
        title: "下一页",
        commandId: "next-page",
        parameters: { cursor, callerId: state.id },
      });
    }
    return { items };
  }
  async function activate(
    activation: PluginActivation,
    signal?: AbortSignal,
    queryOnly = false,
  ): Promise<JsonValue | undefined> {
    assertActive();
    if (signal?.aborted) throw new Error("Search query cancelled");
    if (!activation.commandId) return;
    if (queryOnly && !["search", "content"].includes(activation.commandId))
      throw new Error("Search query cannot perform host actions");
    const parameters =
      activation.parameters &&
      typeof activation.parameters === "object" &&
      !Array.isArray(activation.parameters)
        ? activation.parameters
        : {};
    const state = caller(parameters);
    if (activation.commandId === "settings") {
      const input = z
        .discriminatedUnion("action", [
          z.strictObject({ action: z.literal("get") }),
          z.strictObject({
            action: z.literal("save"),
            excludedRoots: settingsSchema.shape.excludedRoots,
            extensions: settingsSchema.shape.extensions.optional(),
            maxFileMiB: settingsSchema.shape.maxFileMiB.optional(),
            includeHidden: settingsSchema.shape.includeHidden.optional(),
          }),
        ])
        .parse(parameters);
      if (input.action === "get") return structuredClone(settings);
      const { action: _action, ...changes } = input;
      const next = validateSettings({
        ...settings,
        ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
      });
      revokeAll();
      return serialize(async () => {
        assertActive();
        const stopped = await cancelAll();
        if (!stopped.ok) throw new Error(stopped.reason);
        assertActive();
        atomicWrite(settingsFile, JSON.stringify(next, null, 2));
        settings = next;
        return structuredClone(settings);
      });
    }
    if (activation.commandId === "service") {
      const input = z
        .discriminatedUnion("action", [
          z.strictObject({ action: z.literal("status") }),
          z.strictObject({ action: z.literal("rebuild") }),
          z.strictObject({
            action: z.literal("configure"),
            excludedRoots: z.array(z.string().trim().min(1).max(32768)).max(128),
            volumeEnabled: z
              .array(z.strictObject({ id: z.string().min(1).max(256), enabled: z.boolean() }))
              .max(64),
          }),
        ])
        .parse(parameters);
      let serviceParameters;
      if (input.action === "configure") {
        const next = validateSettings({ excludedRoots: input.excludedRoots });
        if (next.excludedRoots.some((root) => !/^[a-z]:\\.+/i.test(root)))
          throw new Error(
            "Machine exclusions require local subdirectories; disable a volume using its switch",
          );
        if (
          new Set(input.volumeEnabled.map((volume) => volume.id)).size !==
          input.volumeEnabled.length
        )
          throw new Error("Duplicate volume settings");
        serviceParameters = {
          serviceExcludedRoots: next.excludedRoots,
          enabledVolumeIds: input.volumeEnabled
            .filter((volume) => volume.enabled)
            .map((volume) => volume.id),
          disabledVolumeIds: input.volumeEnabled
            .filter((volume) => !volume.enabled)
            .map((volume) => volume.id),
        };
      }
      if (input.action !== "status" && !(await options.confirmServiceAction(input.action)))
        return {
          status: "authorization-denied",
          message: "Service management was cancelled",
          connected: false,
          volumes: [],
          excludedRoots: [],
          effectiveExcludedRoots: [],
        };
      if (input.action !== "status") {
        revokeAll();
      }
      const result = await native(
        undefined,
        input.action === "status"
          ? "service-status"
          : input.action === "configure"
            ? "service-configure"
            : "service-rebuild",
        generation,
        serviceParameters,
      );
      return result
        ? {
            status: result.status,
            message: result.message || result.service?.message || "",
            connected: false,
            volumes: [],
            excludedRoots: [],
            effectiveExcludedRoots: [],
            ...result.service,
          }
        : undefined;
    }
    if (["open", "reveal", "copy-path", "preview"].includes(activation.commandId)) {
      const selected =
        typeof parameters.selection === "string"
          ? state.selections.get(parameters.selection)
          : undefined;
      if (!selected) throw new Error("Search selection expired");
      const filename = selected.path;
      if (
        excludedRoots().some(
          (root) => inside(root, path.resolve(filename)) || inside(root, canonical(filename)),
        )
      )
        throw new Error("Search scope was revoked");
      if (selected.version && !currentVersion(filename, selected.version))
        return info(
          "文件已更改，请重新搜索",
          "旧命中位置已经失效。",
          state.lastQuery?.mode === "content" ? "content" : "search",
        );
      if (activation.commandId === "reveal") {
        if (!options.revealPath) throw new Error("Reveal action is unavailable");
        await options.revealPath(filename);
        return;
      }
      if (activation.commandId === "copy-path") {
        if (!options.copyPath) throw new Error("Copy path action is unavailable");
        await options.copyPath(filename);
        return;
      }
      if (activation.commandId === "preview") {
        const handle = fs.openSync(filename, "r");
        let data: Buffer;
        let bytes: number;
        try {
          const metadata = fs.fstatSync(handle, { bigint: true });
          if (!selected.version || !sameVersion(metadata, selected.version))
            throw new Error("Search file version changed; search again");
          const buffer = Buffer.alloc(
            Number(metadata.size > 256n * 1024n ? 256n * 1024n : metadata.size),
          );
          bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
          if (
            !sameVersion(fs.fstatSync(handle, { bigint: true }), selected.version) ||
            !currentVersion(filename, selected.version)
          )
            throw new Error("Search file version changed while reading; search again");
          data = buffer.subarray(0, bytes);
        } finally {
          fs.closeSync(handle);
        }
        const text =
          data[0] === 0xff && data[1] === 0xfe
            ? data.subarray(2).toString("utf16le")
            : data[0] === 0xfe && data[1] === 0xff
              ? Buffer.from(data.subarray(2, data.length - (data.length % 2)))
                  .swap16()
                  .toString("utf16le")
              : data.toString("utf8").replace(/^\uFEFF/, "");
        const lines = text.split(/\r?\n/),
          line = Math.max(1, selected.line);
        const firstLine = Math.max(1, line - 8),
          readable = !text.includes("\uFFFD") && line <= lines.length;
        return {
          searchPreview: {
            path: filename,
            line,
            snippet: selected.snippet,
            firstLine: readable ? firstLine : line,
            text: readable
              ? lines
                  .slice(firstLine - 1, line + 8)
                  .join("\n")
                  .slice(0, 65536)
              : selected.snippet,
          },
        };
      }
      const error = await options.openPath(filename);
      if (error) throw new Error(error);
      return;
    }
    if (activation.commandId === "next-page") {
      const cursor =
        typeof parameters.cursor === "string" ? state.cursors.get(parameters.cursor) : undefined;
      if (!cursor || cursor.generation !== state.generation)
        throw new Error("Search cursor expired");
      return search(cursor.query, state, signal, true);
    }
    if (activation.commandId === "install-service") {
      if (!(await options.confirmServiceAction("install")))
        return info("尚未安装搜索服务，点击重试", "你已取消安装；普通查询不会请求管理员权限。");
      assertActive();
      const retry = state.lastQuery;
      const retrySignal = state.scopeSignal;
      revokeAll();
      const result = await native(undefined, "install", generation);
      if (!result) return;
      if (result.status !== "ok")
        return info(
          "搜索服务安装未完成，点击重试",
          result.message ?? `Windows error ${result.error ?? 0}`,
        );
      return retry
        ? search(
            { ...retry, offset: 0, revision: undefined },
            caller({ callerId: state.id }),
            retrySignal,
          )
        : { items: [] };
    }
    if (!["search", "content"].includes(activation.commandId))
      throw new Error("Unknown search command");
    return search(
      {
        query:
          typeof parameters.query === "string"
            ? parameters.query.slice(0, 8192)
            : (state.lastQuery?.query ?? ""),
        mode:
          activation.commandId === "content" || parameters.mode === "content" ? "content" : "files",
        directory:
          typeof parameters.directory === "string" && path.isAbsolute(parameters.directory)
            ? parameters.directory
            : "",
        offset: 0,
        limit:
          typeof parameters.limit === "number"
            ? Math.min(200, Math.max(1, Math.trunc(parameters.limit)))
            : 60,
      },
      state,
      signal,
    );
  }
  const runtime: ManagedPluginRuntime = {
    activate: (activation) => activate(activation),
    query: (activation, signal) => activate(activation, signal, true),
  };
  if (options.subscribePrivateRoots) {
    const unsubscribe = options.subscribePrivateRoots(async () => {
      revokeAll();
      await serialize(async () => {
        const decision = await cancelAll();
        if (!decision.ok) throw new Error(decision.reason);
      });
    });
    options.scope.own("event", { dispose: unsubscribe });
  }
  options.scope.own("task", {
    prepareStop: async () => {
      revokeAll();
      return cancelAll();
    },
    async dispose() {
      revokeAll();
      const decision = await cancelAll();
      if (!decision.ok) throw new Error(decision.reason);
      disposed = true;
      callers.clear();
    },
  });
  return runtime;
}
