export type HostPhase = "starting" | "running" | "maintenance" | "quitting" | "exiting";

/**
 * One place that answers "may ordinary interaction reach host services now?".
 * The underlying flags stay with their owners (backup maintenance, the shutdown
 * coordinator, the exit path); this derives a single phase from them so IPC,
 * shortcuts, tray and window creation stop re-deriving it ad hoc.
 */
export class HostLifecycle {
  constructor(
    private readonly state: {
      started: () => boolean;
      maintenance: () => boolean;
      quitting: () => boolean;
      exiting: () => boolean;
    },
  ) {}

  get phase(): HostPhase {
    if (this.state.exiting()) return "exiting";
    if (this.state.quitting()) return "quitting";
    if (this.state.maintenance()) return "maintenance";
    return this.state.started() ? "running" : "starting";
  }

  /** Backup/restore maintenance or a shutdown in progress: new user work is refused. */
  get blocked(): boolean {
    return this.state.maintenance() || this.state.quitting() || this.state.exiting();
  }
}
