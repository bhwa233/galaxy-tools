import { globalShortcut } from "electron";
import type { AppConfig } from "../../src/features/settings/types.js";
import { AppError } from "../persistence.js";

export interface HostShortcutCommand {
  pluginId: string;
  command: { id: string };
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
  private readonly owned = new Set<string>();
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
    for (const shortcut of this.owned) globalShortcut.unregister(shortcut);
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
    this.release();
    try {
      const bindings: Array<[string, () => void | Promise<unknown>]> = [
        [config.globalShortcut, this.options.showLauncher],
        [config.toggleVisibilityShortcut, this.options.toggleVisibility],
      ];
      const commands = this.options.commands();
      for (const [id, shortcut] of Object.entries(config.commandShortcuts ?? {})) {
        const target = commands.find((entry) => `${entry.pluginId}:${entry.command.id}` === id);
        if (target && shortcut)
          bindings.push([
            shortcut,
            () => this.options.activate(target.pluginId, target.command.id),
          ]);
      }
      for (const [shortcut, action] of bindings) {
        if (!shortcut) continue;
        if (this.owned.has(shortcut))
          throw new AppError(
            "shortcutConflict",
            this.english(config)
              ? `Shortcut ${shortcut} is assigned more than once. Choose a different shortcut for each action.`
              : `快捷键 ${shortcut} 重复，请为每个动作选择不同快捷键`,
            { shortcut },
          );
        if (!globalShortcut.register(shortcut, this.invoke(action)))
          throw new AppError(
            "shortcutConflict",
            this.english(config)
              ? `Shortcut ${shortcut} could not be registered. Change it in Settings.`
              : `快捷键 ${shortcut} 无法注册，请在设置中更改`,
            { shortcut },
          );
        this.owned.add(shortcut);
      }
      // Commit only a successful configuration. The caller can configure its
      // previous persisted value after a registration failure/save rollback.
      this.configuration = {
        globalShortcut: config.globalShortcut,
        toggleVisibilityShortcut: config.toggleVisibilityShortcut,
        commandShortcuts: { ...config.commandShortcuts },
        locale: config.locale,
      };
    } catch (error) {
      this.release();
      throw error;
    }
  }
  check(shortcut: string): ShortcutCheck {
    this.assertActive();
    if (!shortcut) return { available: true, conflictType: "none", message: "" };
    if (
      [
        this.configuration.globalShortcut,
        this.configuration.toggleVisibilityShortcut,
        ...Object.values(this.configuration.commandShortcuts ?? {}),
      ].includes(shortcut)
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
