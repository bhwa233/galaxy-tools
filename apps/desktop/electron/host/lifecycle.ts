export type HostPhase = "starting" | "running" | "maintenance" | "quitting" | "exiting";

/**
 * Shell presentation remains available while business data is in maintenance.
 * The owners retain their flags; callers choose shell or business availability.
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

  get shellBlocked(): boolean {
    return this.state.quitting() || this.state.exiting();
  }
}
