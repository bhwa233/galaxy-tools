import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, canonical, confined, inside } from "../../persistence.js";
import { createTrustedNativeProcess, type PluginNativeController } from "../backend.js";
import { PluginResourceScope } from "../resources.js";
import {
  EverythingClient,
  EverythingIpcError,
  isSupportedEverythingVersion,
  type EverythingVersion,
} from "./everything-ipc.js";

/** The bundled portable instance never shares a name with a user install. */
export const BUNDLED_EVERYTHING_INSTANCE = "spark233";
/** User installs: the default instance first, then the 1.5 alpha name. */
export const USER_EVERYTHING_INSTANCES: readonly (string | undefined)[] = [undefined, "1.5a"];

/** Text, Markdown and common source extensions the bundled content index reads. */
export const CONTENT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "rst",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "vue",
  "svelte",
  "py",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "swift",
  "lua",
  "sh",
  "ps1",
  "bat",
  "cmd",
  "sql",
] as const;
/** Folder names never worth content-indexing under a profile. */
const CONTENT_EXCLUDED_FOLDER_NAMES = ["node_modules", ".git", ".svn", ".hg"];

export interface EverythingTarget {
  /** Pipe instance name; `undefined` is the default (unnamed) instance. */
  instance?: string;
  bundled: boolean;
  version: EverythingVersion;
}

/** `exclude_folders` / `folders`: comma list; quoted items escape `\` and `"`. */
export function everythingIniPathList(values: readonly string[]): string {
  return values
    .map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",");
}
/** `content_indexing_*_folders`: Everything filter list, `;` separated, quoted verbatim. */
export function everythingFilterPathList(values: readonly string[]): string {
  return values.map((value) => (/[\s;,"]/.test(value) ? `"${value}"` : value)).join(";");
}

/**
 * Host-owned settings of the bundled instance. Only these keys are rewritten;
 * Everything keeps the rest of its own ini (window state, columns).
 */
export function bundledEverythingSettings(options: {
  profileRoot: string;
  excludedRoots: readonly string[];
}): Record<string, string> {
  const excluded = [...new Set(options.excludedRoots.map((value) => path.resolve(value)))];
  const appData = path.join(options.profileRoot, "AppData");
  return {
    app_data: "0",
    show_tray_icon: "0",
    run_in_background: "1",
    check_for_updates_on_startup: "0",
    allow_check_for_updates: "0",
    // No NTFS volume is read: that would need the Everything Service or an
    // administrator prompt. The profile is folder-indexed with change monitoring.
    auto_include_fixed_volumes: "0",
    auto_include_removable_volumes: "0",
    auto_include_fixed_refs_volumes: "0",
    auto_include_removable_refs_volumes: "0",
    auto_include_fixed_fat_volumes: "0",
    auto_include_removable_fat_volumes: "0",
    auto_include_remote_volumes: "0",
    folders: everythingIniPathList([options.profileRoot]),
    folder_monitor_changes: "1",
    exclude_folders: everythingIniPathList(excluded),
    content_indexing_enabled: "1",
    content_indexing_include_only_folders: everythingFilterPathList([options.profileRoot]),
    content_indexing_include_only_files: CONTENT_EXTENSIONS.map((ext) => `*.${ext}`).join(";"),
    content_indexing_exclude_folders: everythingFilterPathList([
      ...excluded,
      appData,
      ...CONTENT_EXCLUDED_FOLDER_NAMES,
    ]),
    // Content stays in memory; bound each file (unit 2 = MB).
    content_indexing_max_size: "4",
    content_indexing_max_size_unit: "2",
  };
}

/** Rewrites only the given keys of an Everything ini, keeping everything else. */
export function patchEverythingIni(current: string, settings: Record<string, string>): string {
  const pending = new Map(Object.entries(settings));
  const lines = current.replace(/^﻿/, "").split(/\r?\n/);
  if (!lines.some((line) => line.trim().toLowerCase() === "[everything]"))
    lines.unshift("[Everything]");
  const patched = lines.map((line) => {
    const match = /^([A-Za-z0-9_]+)=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1])!;
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  while (patched.length && patched[patched.length - 1] === "") patched.pop();
  const header = patched.findIndex((line) => line.trim().toLowerCase() === "[everything]");
  patched.splice(header + 1, 0, ...[...pending].map(([key, value]) => `${key}=${value}`));
  return `${patched.join("\r\n")}\r\n`;
}

/** Everything reads its own argv; never let a query become another switch. */
export function everythingSearchArgument(query: string): string {
  // Quotes are dropped rather than trusting Everything's argv unescaping;
  // control characters never belong in a search.
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\u0000-\u001f\u007f"]/g;
  const text = query.replace(unsafe, " ").trim().slice(0, 4096);
  return /^[-/]/.test(text) ? ` ${text}` : text;
}

export interface EverythingInstanceOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  executable: string;
  dataDir: string;
  profileRoot: string;
  excludedRoots: () => readonly string[];
  approveTrust: () => boolean | Promise<boolean>;
  onOutputBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  /** Host-only test seams; production uses the defaults. */
  bundledInstance?: string;
  userInstances?: readonly (string | undefined)[];
  startTimeoutMs?: number;
}

/**
 * Chooses the Everything instance for queries and owns the bundled one. A user
 * install (>= 1.5) wins; otherwise the bundled portable copy is started once in
 * the background under its own instance name with config and database in the
 * plugin data directory.
 */
export class EverythingInstances {
  private target?: EverythingTarget;
  private starting?: Promise<EverythingTarget>;
  private process?: PluginNativeController;
  private disposed = false;
  readonly bundledInstance: string;
  private readonly userInstances: readonly (string | undefined)[];
  private readonly root: string;
  private readonly executable: string;
  private readonly directory: string;

  constructor(private readonly options: EverythingInstanceOptions) {
    this.bundledInstance = options.bundledInstance ?? BUNDLED_EVERYTHING_INSTANCE;
    this.userInstances = options.userInstances ?? USER_EVERYTHING_INSTANCES;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.bundledInstance))
      throw new Error("Invalid Everything instance name");
    this.root = canonical(options.pluginRoot);
    this.executable = canonical(options.executable);
    if (!path.isAbsolute(options.executable) || !inside(this.root, this.executable))
      throw new Error("Everything executable must be inside the search package");
    this.directory = confined(options.dataDir, "everything");
    if (inside(this.root, canonical(options.dataDir)))
      throw new Error("Everything data must be outside its package");
  }

  /** Connects to the chosen instance, probing and starting it when needed. */
  async connect(
    signal?: AbortSignal,
  ): Promise<{ client: EverythingClient; target: EverythingTarget }> {
    if (this.disposed) throw new EverythingIpcError("Everything is stopped", "closed");
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = this.target ?? (await this.resolve(signal));
      try {
        const client = await EverythingClient.connect({
          instance: target.instance,
          timeoutMs: 3000,
          signal,
        });
        return { client, target };
      } catch (error) {
        // The chosen instance exited; probe again once.
        if (!(error instanceof EverythingIpcError) || error.code !== "not-running") throw error;
        if (this.target === target) this.target = undefined;
      }
    }
    throw new EverythingIpcError("Everything is not running", "not-running");
  }

  /** The current choice without starting anything (for diagnostics). */
  current(): EverythingTarget | undefined {
    return this.target;
  }

  private async probe(instance: string | undefined, bundled: boolean) {
    let client: EverythingClient | undefined;
    try {
      client = await EverythingClient.connect({ instance, timeoutMs: 1500 });
      const version = await client.version();
      if (!isSupportedEverythingVersion(version)) return;
      return { instance, bundled, version } satisfies EverythingTarget;
    } catch {
      return;
    } finally {
      client?.close();
    }
  }

  private async resolve(signal?: AbortSignal): Promise<EverythingTarget> {
    for (const instance of this.userInstances) {
      signal?.throwIfAborted();
      const found = await this.probe(instance, false);
      if (found) return (this.target = found);
    }
    signal?.throwIfAborted();
    const running = await this.probe(this.bundledInstance, true);
    if (running) return (this.target = running);
    this.starting ??= this.startBundled().finally(() => {
      this.starting = undefined;
    });
    return (this.target = await this.starting);
  }

  private instanceArguments(instance: string | undefined): string[] {
    return instance ? ["-instance", instance] : [];
  }

  private async startBundled(): Promise<EverythingTarget> {
    fs.mkdirSync(this.directory, { recursive: true });
    const config = confined(this.directory, "Everything.ini");
    const database = confined(this.directory, "Everything.db");
    const settings = bundledEverythingSettings({
      profileRoot: this.options.profileRoot,
      excludedRoots: this.options.excludedRoots(),
    });
    atomicWrite(
      config,
      patchEverythingIni(fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "", settings),
    );
    if (this.disposed || this.options.scope.state !== "active")
      throw new EverythingIpcError("Search plugin is disabled", "closed");
    this.process = await createTrustedNativeProcess({
      scope: this.options.scope,
      pluginRoot: this.root,
      descriptor: {
        path: this.executable,
        args: [
          ...this.instanceArguments(this.bundledInstance),
          "-config",
          config,
          "-db",
          database,
          "-startup",
          "-no-auto-include",
        ],
      },
      approveTrust: this.options.approveTrust,
      onOutputBytes: this.options.onOutputBytes,
      prepareStop: () => ({ ok: true }),
      requestShutdown: () => this.exitBundled(),
      timeoutMs: 15000,
    });
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 15000);
    while (Date.now() < deadline) {
      const found = await this.probe(this.bundledInstance, true);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new EverythingIpcError("The bundled Everything did not start", "timeout");
  }

  /** Runs the bundled executable briefly to forward a command line to an instance. */
  private async forward(args: string[]): Promise<void> {
    const scope = new PluginResourceScope(this.options.scope.owner);
    try {
      const helper = await createTrustedNativeProcess({
        scope,
        pluginRoot: this.root,
        descriptor: { path: this.executable, args },
        approveTrust: this.options.approveTrust,
        onOutputBytes: this.options.onOutputBytes,
        prepareStop: () => ({ ok: true }),
        requestShutdown: () => undefined,
        timeoutMs: 10000,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        helper.waitForExit().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 10000);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) throw new Error("Everything did not accept the command");
    } finally {
      // A helper that did not exit is force-terminated with its scope.
      await scope.stop("quit").catch(() => undefined);
    }
  }

  private exitBundled(): Promise<void> {
    // Not routed through the plugin scope: shutdown must not depend on it.
    return new Promise((resolve) => {
      const child = spawn(
        this.executable,
        [...this.instanceArguments(this.bundledInstance), "-exit"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 10000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Opens the Everything window of the chosen instance with a search. */
  async openWindow(query: string, signal?: AbortSignal): Promise<void> {
    const { client, target } = await this.connect(signal);
    client.close();
    const text = everythingSearchArgument(query);
    await this.forward([
      ...this.instanceArguments(target.instance),
      // `-focus-search-edit` makes 1.5.0.1424b keep the forwarding process
      // alive (verified), so only `-search` is passed; the window opens focused.
      ...(text ? ["-search", text] : []),
    ]);
  }

  /** Opens Everything's options of the chosen instance. */
  async openOptions(signal?: AbortSignal): Promise<void> {
    const { client, target } = await this.connect(signal);
    client.close();
    await this.forward([...this.instanceArguments(target.instance), "-options"]);
  }

  /** Called from the plugin scope; the bundled process is stopped by its own resource. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const bundled = this.target?.bundled && !this.process;
    this.target = undefined;
    // An instance this runtime adopted (left from an earlier session) is ours too.
    if (bundled) await this.exitBundled();
  }
}
