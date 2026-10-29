/** Reuse the existing launcher presenter; only the asynchronous selection handoff
 * needs its own cancellation generation. No second window or command matcher. */
export class SelectionLauncher {
  private generation = 0;
  private pending?: AbortController;
  private stopped = false;

  constructor(
    private readonly options: {
      read(signal: AbortSignal): Promise<string>;
      prepare?(signal: AbortSignal): Promise<void>;
      present(text: string, revision: number, signal: AbortSignal): void | Promise<void>;
    },
  ) {}

  async open(): Promise<void> {
    if (this.stopped) return;
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.pending = controller;
    const preparation =
      this.options.prepare?.(controller.signal).catch(() => {}) ?? Promise.resolve();
    let text = "";
    try {
      text = await this.options.read(controller.signal);
    } catch {
      // Unsupported, inaccessible or timed-out selection opens an empty input.
    }
    await preparation;
    if (this.stopped || controller.signal.aborted || generation !== this.generation) return;
    try {
      await this.options.present(text, generation, controller.signal);
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  cancel(): void {
    ++this.generation;
    this.pending?.abort();
    this.pending = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }
}
