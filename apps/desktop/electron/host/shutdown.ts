export interface ShutdownCoordinatorOptions<Window> {
  awaitWrites: () => void | Promise<unknown>;
  awaitReleases: () => void | Promise<unknown>;
  windows: () => Iterable<Window>;
  remember: (window: Window) => void;
  persist: () => void | Promise<unknown>;
  shutdownPlugins: () => void | Promise<unknown>;
  onCommit: () => void | Promise<unknown>;
  onError: (error: unknown) => void | Promise<void>;
}

/** Finish current writes and cleanup within a bounded, non-vetoable exit. */
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
  private async run(): Promise<void> {
    this.quitting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Quit is a user decision. Give current writes and plugin cleanup a short
    // grace period, but neither a refusal nor an unanswered IPC may veto exit.
    const cleanup = async () => {
      for (const finish of [
        this.options.awaitReleases,
        this.options.awaitWrites,
        () => {
          for (const window of this.options.windows()) this.options.remember(window);
        },
        this.options.persist,
        this.options.shutdownPlugins,
      ]) {
        try {
          await finish();
        } catch (error) {
          this.report(error);
        }
      }
    };
    try {
      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.committed = true;
      await this.options.onCommit();
    }
  }
  private report(error: unknown): void {
    // Reporting must never introduce another dialog or wait into the quit path.
    void Promise.resolve()
      .then(() => this.options.onError(error))
      .catch((reportError) => console.error("shutdown-error-report", reportError));
  }
}
