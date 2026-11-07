import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonValue, PluginActivation } from "../../sdk/src/index.js";
import { canonical, inside } from "../../../apps/desktop/electron/persistence.js";
import {
  EverythingIpcError,
  EverythingProperty,
  type EverythingSearchResult,
} from "./everything-ipc.js";
import { CONTENT_EXTENSIONS, EverythingInstances } from "./everything-instance.js";

export interface SearchRuntimeOptions {
  pluginRoot: string;
  /** The bundled Everything 1.5 executable inside the package. */
  executable: string;
  dataDir: string;
  cacheDir: string;
  /** Isolated integration scope for tests. Never sourced from activation input. */
  fixture?: {
    profileRoot: string;
    bundledInstance: string;
    userInstances: readonly (string | undefined)[];
  };
}

type Mode = "files" | "content";
type Query = { mode: Mode; query: string; directory: string; offset: number; limit: number };
type CallerState = {
  id: string;
  generation: number;
  controller?: AbortController;
  selections: Map<string, string>;
  cursors: Map<string, { query: Query; generation: number }>;
  windows: Map<string, { query: string; mode: Mode }>;
  lastQuery?: Query;
};

/**
 * What the host performs for a chosen result. The plugin never opens files
 * itself; the host checks the path against its private roots first.
 */
export type SearchHostAction = { hostAction: "open" | "reveal" | "copy-path"; path: string };
export interface SearchRuntime {
  /**
   * The host adds `locale`, `privateRoots` (host data the results must never
   * show) and, for launcher queries, `queryOnly` to the parameters.
   */
  activate(activation: PluginActivation, signal?: AbortSignal): Promise<JsonValue | undefined>;
  /** Forget every selection, cursor and window token. */
  revoke(): void;
  dispose(): Promise<void>;
}

/** Files written by the Pulse-backed versions of this plugin. */
const LEGACY_DATA = ["search-scope.json", "workspace-history.json"];

/** Each term must occur in the file content; quotes are Everything grouping. */
export function contentSearchText(query: string, indexed: boolean, profileRoot: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replaceAll('"', ""))
    .filter(Boolean);
  if (!terms.length) return "";
  const prefix = indexed ? "content:" : "notindexed:content:";
  const matches = terms.map((term) => `${prefix}"${term}"`).join(" ");
  // Without a content index Everything reads files from disk; keep that to
  // the user's text files.
  return indexed ? matches : `"${profileRoot}\\" ext:${CONTENT_EXTENSIONS.join(";")} ${matches}`;
}

export function createSearchRuntime(options: SearchRuntimeOptions): SearchRuntime {
  let locale = "zh-CN";
  let privateRoots: readonly string[] = [];
  const ui = (zh: string, en: string) => (locale.startsWith("en") ? en : zh);
  for (const directory of [options.dataDir, options.cacheDir]) {
    if (!path.isAbsolute(directory)) throw new Error("Search data/cache must be absolute");
    fs.mkdirSync(directory, { recursive: true });
  }
  // Pulse-era settings and workspace history are no longer read.
  for (const name of LEGACY_DATA) fs.rmSync(path.join(options.dataDir, name), { force: true });
  fs.rmSync(path.join(options.cacheDir, "sessions"), { recursive: true, force: true });

  const profileRoot = options.fixture?.profileRoot ?? os.homedir();
  function excludedRoots(): string[] {
    return [
      ...new Set(
        [...privateRoots, options.dataDir, options.cacheDir].flatMap((value) => [
          path.resolve(value),
          canonical(value),
        ]),
      ),
    ];
  }
  const everything = new EverythingInstances({
    pluginRoot: options.pluginRoot,
    executable: options.executable,
    dataDir: options.dataDir,
    profileRoot,
    excludedRoots,
    ...(options.fixture
      ? {
          bundledInstance: options.fixture.bundledInstance,
          userInstances: options.fixture.userInstances,
        }
      : {}),
  });

  const callers = new Map<string, CallerState>();
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
      state = {
        id,
        generation: 0,
        selections: new Map(),
        cursors: new Map(),
        windows: new Map(),
      };
      callers.set(id, state);
    }
    return state;
  }
  function revokeAll(): void {
    for (const state of callers.values()) {
      ++state.generation;
      state.controller?.abort();
      state.selections.clear();
      state.cursors.clear();
      state.windows.clear();
    }
    callers.clear();
  }
  function assertActive(): void {
    if (disposed) throw new Error("Search plugin is disabled");
  }
  function isExcluded(filename: string, excluded = excludedRoots()): boolean {
    const resolved = path.resolve(filename);
    return excluded.some((root) => inside(root, resolved) || inside(root, canonical(resolved)));
  }
  function message(title: string, description: string, commandId: string, query: Query): JsonValue {
    return {
      items: [
        {
          id: randomUUID(),
          title,
          description,
          commandId,
          parameters: { query: query.query, mode: query.mode },
        },
      ],
    };
  }

  async function search(
    query: Query,
    state: CallerState,
    signal?: AbortSignal,
    append = false,
  ): Promise<JsonValue | undefined> {
    // A newer query of the same caller abandons the older one's pipe request.
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const mine = ++state.generation;
    if (!append) {
      state.selections.clear();
      state.windows.clear();
    }
    state.cursors.clear();
    state.lastQuery = query;
    const stale = () => combined.aborted || mine !== state.generation || disposed;
    if (!query.query.trim()) return { items: [] };
    let connection;
    try {
      connection = await everything.connect(combined);
    } catch (error) {
      if (stale()) return;
      return unavailable(error, query);
    }
    const { client, target } = connection;
    let result: EverythingSearchResult;
    let loaded = true;
    // The bundled instance is configured with a content index; a user install
    // may have it off, which is checked per query because it can change.
    let indexed = true;
    try {
      if (target.bundled) loaded = await client.isDbLoaded();
      else if (query.mode === "content")
        indexed = await client.isPropertyIndexed(EverythingProperty.content);
      let text =
        query.mode === "content"
          ? contentSearchText(query.query, indexed, profileRoot)
          : query.query;
      // Everything matches a backslash term against the full path.
      if (query.directory && text) text = `"${query.directory.replace(/\\+$/, "")}\\" ${text}`;
      result = await client.search(
        {
          text,
          offset: query.offset,
          count: query.limit,
          sort: [{ property: EverythingProperty.name }],
          properties: [EverythingProperty.name, EverythingProperty.path],
        },
        combined,
      );
    } catch (error) {
      if (stale()) return;
      return unavailable(error, query);
    } finally {
      client.close();
    }
    if (stale()) return;
    const items: JsonValue[] = [];
    const excluded = excludedRoots();
    for (const item of result.items) {
      const name = item.values.get(EverythingProperty.name);
      const parent = item.values.get(EverythingProperty.path);
      if (typeof name !== "string" || typeof parent !== "string") continue;
      const filename = path.win32.join(parent, name);
      if (!path.win32.isAbsolute(filename) || isExcluded(filename, excluded)) continue;
      const id = randomUUID();
      state.selections.set(id, filename);
      items.push({
        id,
        title: name,
        description: filename,
        kind: item.folder ? "directory" : "file",
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
        ],
      });
    }
    const total = result.folderCount + result.fileCount;
    if (BigInt(query.offset + result.items.length) < total) {
      const cursor = randomUUID();
      state.cursors.set(cursor, {
        generation: mine,
        query: { ...query, offset: query.offset + query.limit },
      });
      items.push({
        id: cursor,
        title: ui("下一页", "Next page"),
        commandId: "next-page",
        parameters: { cursor, callerId: state.id },
      });
    }
    const windowToken = randomUUID();
    state.windows.set(windowToken, {
      query:
        query.mode === "content"
          ? contentSearchText(query.query, indexed, profileRoot)
          : query.query,
      mode: query.mode,
    });
    items.push({
      id: windowToken,
      title: ui("在 Everything 中查看全部", "Show all in Everything"),
      description: ui(`共 ${total} 项`, `${total} results`),
      commandId: "open-everything",
      parameters: { token: windowToken, callerId: state.id },
    });
    const hint = !loaded
      ? ui("正在准备文件索引，结果会逐步补充", "Preparing the file index; results will fill in")
      : query.mode === "content" && !indexed
        ? ui(
            "当前 Everything 未开启内容索引，正文搜索会较慢。可在 Everything 选项的「内容」中开启。",
            "Content indexing is off in Everything, so content search is slow. Turn it on under Everything Options > Content.",
          )
        : undefined;
    return { items, ...(hint ? { hint } : {}) };
  }

  function unavailable(error: unknown, query: Query): JsonValue {
    if (!(error instanceof EverythingIpcError)) console.error("search-everything", error);
    return message(
      ui("文件搜索暂时不可用，点击重试", "File search is unavailable. Click to retry"),
      error instanceof EverythingIpcError && error.code === "timeout"
        ? ui("Everything 响应超时。", "Everything did not respond in time.")
        : ui("无法连接 Everything。", "Could not connect to Everything."),
      query.mode === "content" ? "content" : "search",
      query,
    );
  }

  async function activate(
    activation: PluginActivation,
    signal?: AbortSignal,
  ): Promise<JsonValue | undefined> {
    assertActive();
    signal?.throwIfAborted();
    if (!activation.commandId) return;
    const parameters =
      activation.parameters &&
      typeof activation.parameters === "object" &&
      !Array.isArray(activation.parameters)
        ? activation.parameters
        : {};
    if (typeof parameters.locale === "string") locale = parameters.locale;
    if (Array.isArray(parameters.privateRoots))
      privateRoots = parameters.privateRoots.filter(
        (root): root is string => typeof root === "string" && path.isAbsolute(root),
      );
    if (parameters.queryOnly === true && !["search", "content"].includes(activation.commandId))
      throw new Error("Search query cannot perform host actions");
    if (activation.commandId === "revoke") {
      revokeAll();
      return;
    }
    if (activation.commandId === "workspace") {
      await everything.openWindow("", signal);
      return;
    }
    if (activation.commandId === "open-search") {
      const text = activation.context?.kind === "text" ? activation.context.text : "";
      await everything.openWindow(text.slice(0, 4096), signal);
      return;
    }
    if (activation.commandId === "settings") {
      await everything.openOptions(signal);
      return;
    }
    const state = caller(parameters);
    if (activation.commandId === "open-everything") {
      const entry =
        typeof parameters.token === "string" ? state.windows.get(parameters.token) : undefined;
      if (!entry) throw new Error("Search selection expired");
      await everything.openWindow(entry.query, signal);
      return;
    }
    if (["open", "reveal", "copy-path"].includes(activation.commandId)) {
      const filename =
        typeof parameters.selection === "string"
          ? state.selections.get(parameters.selection)
          : undefined;
      if (!filename) throw new Error("Search selection expired");
      if (isExcluded(filename)) throw new Error("Search scope was revoked");
      return {
        hostAction: activation.commandId as SearchHostAction["hostAction"],
        path: filename,
      } satisfies SearchHostAction;
    }
    if (activation.commandId === "next-page") {
      const cursor =
        typeof parameters.cursor === "string" ? state.cursors.get(parameters.cursor) : undefined;
      if (!cursor || cursor.generation !== state.generation)
        throw new Error("Search cursor expired");
      return search(cursor.query, state, signal, true);
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
          typeof parameters.directory === "string" &&
          path.win32.isAbsolute(parameters.directory) &&
          !/["\0]/.test(parameters.directory)
            ? parameters.directory
            : "",
        offset: 0,
        limit:
          typeof parameters.limit === "number"
            ? Math.min(98, Math.max(1, Math.trunc(parameters.limit)))
            : 60,
      },
      state,
      signal,
    );
  }

  return {
    activate,
    revoke: revokeAll,
    async dispose() {
      disposed = true;
      revokeAll();
      await everything.dispose();
    },
  };
}
