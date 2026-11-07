import { AppError } from "../persistence.js";

export interface ShutdownCoordinatorOptions<Window> {
  isBlocked: () => boolean;
  awaitWrites: () => void | Promise<unknown>;
  awaitReleases: () => void | Promise<unknown>;
  windows: () => Iterable<Window>;
  prepare: (window: Window) => boolean | Promise<boolean>;
  /** Human-readable name of a window, used to say which one did not save. */
  describe?: (window: Window) => string;
  remember: (window: Window) => void;
  persist: () => void | Promise<unknown>;
  shutdownPlugins: () => void | Promise<unknown>;
  onCommit: () => void | Promise<unknown>;
  onError: (error: unknown) => void | Promise<void>;
  getLocale?: () => string;
}

/** Coordinate the existing save/exit boundary. Window owners and the plugin
 * manager still perform their own durable save and resource cleanup. */
export class ShutdownCoordinator<Window> {
  private pending?: Promise<void>;
  private quitting = false;
  private committed = false;

  constructor(private readonly options: ShutdownCoordinatorOptions<Window>) {}

  get isQuitting(): boolean {
    return this.quitting;
  }

  request(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.committed) return Promise.resolve();
    const operation = this.run();
    this.pending = operation;
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private english(): boolean {
    return (this.options.getLocale?.() ?? "zh-CN").toLowerCase().startsWith("en");
  }
  private assertNotBlocked(): void {
    if (this.options.isBlocked())
      throw new AppError(
        "maintenance",
        this.english()
          ? "A backup or restore is running. Wait until it finishes before quitting."
          : "正在备份或恢复，请等待完成再退出",
      );
  }
  private async run(): Promise<void> {
    try {
      this.assertNotBlocked();
      this.quitting = true;
      await this.options.awaitReleases();
      await this.options.awaitWrites();
      this.assertNotBlocked();
      const candidates = [...this.options.windows()];
      const saved = await Promise.allSettled(
        candidates.map((window) => this.options.prepare(window)),
      );
      const unsaved = candidates
        .filter((_, index) => {
          const result = saved[index]!;
          return !(result.status === "fulfilled" && result.value);
        })
        .map((window) => this.options.describe?.(window) ?? "")
        .filter(Boolean);
      if (saved.some((result) => !(result.status === "fulfilled" && result.value)))
        throw new AppError(
          "saveFailed",
          (this.english()
            ? "Some windows could not finish saving. Quitting was cancelled."
            : "有窗口未完成保存，已取消退出") + (unsaved.length ? ": " + unsaved.join(", ") : ""),
          { windows: unsaved.join(", ") },
        );
      for (const window of this.options.windows()) this.options.remember(window);
      await this.options.persist();
      this.assertNotBlocked();
      await this.options.shutdownPlugins();
      await this.options.onCommit();
      this.committed = true;
      // Committed: plugins are gone and the process is exiting. Keep the fence up
      // so shortcuts, tray and IPC writes cannot reach torn-down services.
    } catch (error) {
      // Saving has failed and automatic shutdown has stopped. A decision dialog
      // may remain open, so it must not keep ordinary interaction fenced.
      this.quitting = false;
      try {
        await this.options.onError(error);
      } catch (reportError) {
        console.error("shutdown-error-report", reportError);
      }
    }
  }
}
