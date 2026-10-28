import { globalShortcut } from "electron";
import type { AppConfig } from "../../src/features/settings/types.js";
import { AppError } from "../persistence.js";
import { shortcutIdentity } from "../../src/features/settings/shortcutRecorder.js";

export interface HostShortcutCommand {
  pluginId: string;
  command: { id: string; title?: string; translations?: { "en-US"?: { title: string } } };
}
export interface ShortcutManagerOptions {
  showLauncher: () => void | Promise<unknown>;
  toggleVisibility: () => void | Promise<unknown>;
  commands: () => readonly HostShortcutCommand[];
  activate: (pluginId: string, commandId: string) => void | Promise<unknown>;
  onError: (error: unknown) => void;
  isBlocked?: () => boolean;
  getLocale?: () => string;
}
export interface ShortcutCheck {
  available: boolean;
  conflictType: "none" | "current" | "registered" | "invalid";
  message: string;
}
type Configuration = Pick<
  AppConfig,
  "globalShortcut" | "toggleVisibilityShortcut" | "commandShortcuts"
> & { locale?: string };

/** Own the host's Electron registrations, including its configured public
 * plugin commands. SDK plugins keep their separately owned registrations. */
export class ShortcutManager {
  private owned = new Map<string, { shortcut: string; action: () => void | Promise<unknown> }>();
  private recording = false;
  private disposed = false;
  private configuration: Configuration = {
    globalShortcut: "",
    toggleVisibilityShortcut: "",
    commandShortcuts: {},
  };

  constructor(private readonly options: ShortcutManagerOptions) {}

  get isRecording(): boolean {
    return this.recording;
  }

  private english(config?: Configuration): boolean {
    return (config?.locale ?? this.options.getLocale?.() ?? this.configuration.locale ?? "zh-CN")
      .toLowerCase()
      .startsWith("en");
  }
  private assertActive(): void {
    if (this.disposed) throw new AppError("hostDisposed", "Shortcut manager has been disposed");
  }
  private release(): void {
    for (const entry of this.owned.values()) globalShortcut.unregister(entry.shortcut);
    this.owned.clear();
  }
  private report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch (reportError) {
      console.error("shortcut-error-report", reportError);
    }
  }
  private invoke(action: () => void | Promise<unknown>): () => void {
    return () => {
      if (this.disposed || this.recording || this.options.isBlocked?.()) return;
      try {
        void Promise.resolve(action()).catch((error) => this.report(error));
      } catch (error) {
        this.report(error);
      }
    };
  }
  configure(config: Configuration): void {
    this.assertActive();
    const english = this.english(config);
    const identity = (shortcut: string) =>
      shortcutIdentity(shortcut, process.platform === "darwin" ? "mac" : "windows");
    const commands = this.options.commands();
    // Lifecycle changes must free unavailable commands even when another new
    // binding fails to register. Keep unrelated working host bindings intact.
    for (const [id, shortcut] of Object.entries(this.configuration.commandShortcuts ?? {})) {
      if (!shortcut || commands.some((entry) => entry.pluginId + ":" + entry.command.id === id))
        continue;
      const key = identity(shortcut);
      const owned = this.owned.get(key);
      if (owned) {
        globalShortcut.unregister(owned.shortcut);
        this.owned.delete(key);
      }
    }
    const configured: Array<[string, string]> = [
      [config.globalShortcut, english ? "Open launcher" : "打开启动器"],
      [config.toggleVisibilityShortcut, english ? "Show/hide note windows" : "显示/隐藏便签窗口"],
      ...Object.entries(config.commandShortcuts ?? {}).map(([id, shortcut]): [string, string] => {
        const entry = commands.find(
          (command) => command.pluginId + ":" + command.command.id === id,
        );
        const title = english
          ? (entry?.command.translations?.["en-US"]?.title ?? entry?.command.title)
          : entry?.command.title;
        return [shortcut, title ? id.split(":")[0] + " · " + title : id];
      }),
    ];
    const assigned = new Map<string, string>();
    for (const [shortcut, title] of configured) {
      if (!shortcut) continue;
      const key = identity(shortcut);
      if (assigned.has(key))
        throw new AppError(
          "shortcutConflict",
          english
            ? shortcut + " is assigned to both " + assigned.get(key) + " and " + title
            : "快捷键 " + shortcut + " 同时分配给「" + assigned.get(key) + "」和「" + title + "」",
          { shortcut },
        );
      assigned.set(key, title);
    }
    const bindings: Array<[string, () => void | Promise<unknown>]> = [
      [config.globalShortcut, this.options.showLauncher],
      [config.toggleVisibilityShortcut, this.options.toggleVisibility],
    ];
    for (const [id, shortcut] of Object.entries(config.commandShortcuts ?? {})) {
      const target = commands.find((entry) => entry.pluginId + ":" + entry.command.id === id);
      if (target && shortcut)
        bindings.push([
          shortcut,
          () => {
            if (
              this.options
                .commands()
                .some(
                  (entry) =>
                    entry.pluginId === target.pluginId && entry.command.id === target.command.id,
                )
            )
              return this.options.activate(target.pluginId, target.command.id);
          },
        ]);
    }
    const next = new Map<string, { shortcut: string; action: () => void | Promise<unknown> }>();
    try {
      if (!this.recording)
        for (const [shortcut, action] of bindings) {
          if (!shortcut) continue;
          const key = identity(shortcut);
          const existing = this.owned.get(key);
          const entry = existing ?? { shortcut, action };
          if (
            !existing &&
            !globalShortcut.register(
              shortcut,
              this.invoke(() => entry.action()),
            )
          )
            throw new AppError(
              "shortcutConflict",
              english
                ? "Shortcut " + shortcut + " could not be registered. Change it in Settings."
                : "快捷键 " + shortcut + " 已被系统或其他程序占用，请在设置中更改",
              { shortcut },
            );
          next.set(key, entry);
        }
    } catch (error) {
      for (const [key, entry] of next)
        if (!this.owned.has(key)) globalShortcut.unregister(entry.shortcut);
      throw error;
    }
    for (const [key, entry] of this.owned)
      if (!next.has(key)) globalShortcut.unregister(entry.shortcut);
    for (const [shortcut, action] of bindings) {
      const entry = next.get(identity(shortcut));
      if (entry) entry.action = action;
    }
    this.owned = next;
    this.configuration = { ...config, commandShortcuts: { ...config.commandShortcuts } };
  }

  check(shortcut: string): ShortcutCheck {
    this.assertActive();
    if (!shortcut) return { available: true, conflictType: "none", message: "" };
    if (
      this.owned.has(shortcutIdentity(shortcut, process.platform === "darwin" ? "mac" : "windows"))
    )
      return { available: true, conflictType: "current", message: "" };
    try {
      const available = globalShortcut.register(shortcut, () => {});
      if (available) globalShortcut.unregister(shortcut);
      return {
        available,
        conflictType: available ? "none" : "registered",
        message: available
          ? ""
          : this.english()
            ? "This shortcut is already in use"
            : "快捷键已被占用",
      };
    } catch {
      return {
        available: false,
        conflictType: "invalid",
        message: this.english() ? "Invalid shortcut" : "快捷键格式无效",
      };
    }
  }
  beginRecording(): void {
    this.assertActive();
    this.recording = true;
    this.release();
  }
  endRecording(config: Configuration): void {
    this.assertActive();
    this.recording = false;
    this.configure(config);
  }
  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.recording = false;
    this.disposed = true;
  }
}
