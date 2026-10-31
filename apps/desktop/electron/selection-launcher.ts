/** Reuse the existing launcher presenter; only the asynchronous selection handoff
 * needs its own cancellation generation. No second window or command matcher.
 * The panel is presented before the read completes, so a slow UIA query can
 * never delay the hotkey response; the text arrives as a patch. */
export class SelectionLauncher {
  private generation = 0;
  private pending?: AbortController;
  private stopped = false;

  constructor(
    private readonly options: {
      /** Foreground window sampled before the panel takes focus; 0 when no
       * warm helper can answer within its own small budget. */
      target(signal: AbortSignal): Promise<number>;
      read(signal: AbortSignal, target: number): Promise<string>;
      present(text: string, revision: number, signal: AbortSignal): void | Promise<void>;
      patch?(text: string, revision: number, signal: AbortSignal): void | Promise<void>;
    },
  ) {}

  async open(): Promise<void> {
    if (this.stopped) return;
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.pending = controller;
    let target = 0;
    try {
      target = await this.options.target(controller.signal);
    } catch {
      // No warm helper: show now and let the read degrade to an empty input.
    }
    if (this.stopped || controller.signal.aborted || generation !== this.generation) return;
    try {
      await this.options.present("", generation, controller.signal);
    } catch (error) {
      if (this.pending === controller) this.pending = undefined;
      throw error;
    }
    let text = "";
    try {
      text = await this.options.read(controller.signal, target);
    } catch {
      // Unsupported, inaccessible or timed-out selection keeps the empty input.
    }
    if (this.stopped || controller.signal.aborted || generation !== this.generation) return;
    if (text) await this.options.patch?.(text, generation, controller.signal);
    if (this.pending === controller) this.pending = undefined;
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
