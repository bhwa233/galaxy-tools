import { randomUUID } from "node:crypto";
import type { PluginContext } from "@spark233/sdk";
import type {
  ContextPanelStatus,
  ContextPanelViewState,
} from "../src/features/context-panel/types.js";
import {
  startContextPanelNative,
  type ContextPanelNativeCapture,
  type ContextPanelNativeConfig,
  type ContextPanelNativeDriver,
  type ContextPanelNativeOptions,
  type ContextPanelNativeTrigger,
} from "./context-panel-native.js";

type Point = ContextPanelNativeTrigger["point"];
export interface ContextPanelMaterialized {
  context?: PluginContext;
  label?: string;
  dispose(): void;
}
export interface ContextPanelCoordinatorOptions {
  nativeOptions: Omit<ContextPanelNativeOptions, "config" | "onTrigger" | "onError">;
  startNative?: (options: ContextPanelNativeOptions) => Promise<ContextPanelNativeDriver>;
  supported?: boolean;
  isBlocked?: () => boolean;
  materialize(
    capture: ContextPanelNativeCapture,
    signal: AbortSignal,
    sourceApplication?: string,
  ): Promise<ContextPanelMaterialized>;
  openView(point: Point): string;
  publish(caller: string, state: ContextPanelViewState): void;
  closeView(caller: string): void;
  focusView?(caller: string): void;
  clearQuery(caller: string): void;
  onStatus?(status: ContextPanelStatus): void;
}
type Pending = { generation: number; abort: AbortController };
type Session = {
  caller: string;
  state: ContextPanelViewState;
  materialized?: ContextPanelMaterialized;
  sourceToken?: string;
  executionId?: string;
};

// LauncherController owns query/command authorization and ResourceStore owns handles.
// Neither owns native capture-to-window handoff; keep only that single-session lifecycle here.
export class ContextPanelCoordinator {
  private readonly supported: boolean;
  private statusValue: ContextPanelStatus;
  private driver?: ContextPanelNativeDriver;
  private driverGeneration = 0;
  private nativeFailures = 0;
  private configurationGeneration = 0;
  private generation = 0;
  private revision = 0;
  private enabled = false;
  private stopped = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private pending?: Pending;
  private session?: Session;
  private presentation?: { caller: string; executionId: string; generation: number };

  constructor(private readonly options: ContextPanelCoordinatorOptions) {
    this.supported = options.supported ?? process.platform === "win32";
    this.statusValue = { supported: this.supported, phase: "disabled" };
  }

  get status(): ContextPanelStatus {
    return { ...this.statusValue };
  }

  configure(config: ContextPanelNativeConfig): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Context panel stopped"));
    const next = {
      ...config,
      excludedApps: [...config.excludedApps],
      copyFallback: config.copyFallback ?? false,
    };
    const configuration = ++this.configurationGeneration;
    this.enabled = next.enabled;
    this.invalidate();
    this.setStatus(!next.enabled ? "disabled" : this.supported ? "starting" : "unavailable");
    const work = this.lifecycle
      .catch(() => {})
      .then(async () => {
        if (configuration !== this.configurationGeneration || this.stopped) return;
        if (!next.enabled || !this.supported) {
          // Keep the driver on failure so a later disable/shutdown can retry its real drain.
          if (this.driver) {
            await this.driver.stop();
            this.driver = undefined;
            ++this.driverGeneration;
          }
          return;
        }
        const failures = this.nativeFailures;
        try {
          if (this.driver) await this.driver.update(next);
          else {
            const generation = ++this.driverGeneration;
            this.driver = await (this.options.startNative ?? startContextPanelNative)({
              ...this.options.nativeOptions,
              config: next,
              onTrigger: (trigger) => {
                if (generation === this.driverGeneration) void this.trigger(trigger);
              },
              onError: () => {
                if (generation !== this.driverGeneration || this.stopped || !this.enabled) return;
                ++this.nativeFailures;
                ++this.generation;
                this.cancelPending();
                if (this.session?.sourceToken) this.retire(this.session);
                this.setStatus("unavailable");
              },
            });
          }
          if (
            configuration === this.configurationGeneration &&
            !this.stopped &&
            failures === this.nativeFailures
          )
            this.setStatus("ready");
        } catch {
          if (configuration === this.configurationGeneration && !this.stopped)
            this.setStatus("unavailable");
        }
      });
    this.lifecycle = work;
    return work;
  }

  async trigger(trigger: ContextPanelNativeTrigger): Promise<void> {
    const driver = this.driver;
    if (
      this.stopped ||
      this.options.isBlocked?.() ||
      !this.enabled ||
      this.statusValue.phase !== "ready" ||
      !driver
    )
      return;
    this.invalidate();
    const pending: Pending = { generation: this.generation, abort: new AbortController() };
    this.pending = pending;
    let materialized: ContextPanelMaterialized | undefined;
    try {
      const capture = await driver.capture(trigger.sourceToken, randomUUID(), pending.abort.signal);
      if (!this.current(pending)) return;
      if (capture.kind !== "none" && capture.sourceToken !== trigger.sourceToken)
        throw new Error("Context source changed");
      // Capture and host materialization finish while the source still has focus.
      materialized = await this.options.materialize(
        capture,
        pending.abort.signal,
        this.sourceApp(trigger.sourceApp),
      );
      if (!this.current(pending)) {
        this.dispose(materialized);
        return;
      }
      const caller = this.options.openView(trigger.point);
      if (!this.current(pending)) {
        this.dispose(materialized);
        materialized = undefined;
        this.options.closeView(caller);
        return;
      }
      this.pending = undefined;
      const session: Session = {
        caller,
        materialized,
        sourceToken: trigger.sourceToken,
        state: {
          sessionId: randomUUID(),
          revision: ++this.revision,
          status: materialized.context ? "ready" : "no-context",
          contextKind: materialized.context?.kind,
          sourceApp: this.sourceApp(trigger.sourceApp),
          reason: materialized.context ? undefined : this.reason(capture),
          suggestedQuery: capture.kind === "text" ? this.suggestedQuery(capture.text) : undefined,
          returnAvailable: true,
        },
      };
      this.session = session;
      materialized = undefined; // Ownership transferred to this exact session.
      try {
        this.options.publish(caller, { ...session.state });
        if (this.session === session) this.options.focusView?.(caller);
      } catch {
        this.retire(session);
      }
    } catch {
      if (materialized) this.dispose(materialized);
      if (!this.current(pending)) return;
      this.pending = undefined;
      // Never publish a partial capture or an untrusted exception string.
      try {
        this.open(trigger.point, "error", "unavailable");
      } catch {
        /* View could not be created. */
      }
    }
  }

  openCommon(point: Point): string {
    if (this.stopped || this.options.isBlocked?.()) throw new Error("Context panel unavailable");
    this.invalidate();
    return this.open(point, "no-context", "empty");
  }

  context(caller: string): PluginContext | undefined {
    return this.owned(caller)?.materialized?.context;
  }
  contextLabel(caller: string): string | undefined {
    return this.owned(caller)?.materialized?.label;
  }
  contextRevision(caller: string): number {
    return this.owned(caller)?.state.revision ?? 0;
  }
  state(caller: string): ContextPanelViewState | undefined {
    const state = this.owned(caller)?.state;
    return state ? { ...state } : undefined;
  }

  clearContext(caller: string): void {
    const session = this.owned(caller);
    if (!session) return;
    const materialized = session.materialized;
    ++this.generation;
    session.materialized = undefined;
    session.executionId = undefined;
    if (materialized) this.dispose(materialized);
    try {
      this.options.clearQuery(caller);
    } catch {
      /* Context is already revoked. */
    }
    session.state = {
      ...session.state,
      revision: ++this.revision,
      status: "no-context",
      contextKind: undefined,
      reason: "empty",
      suggestedQuery: undefined,
    };
    this.options.publish(caller, { ...session.state });
  }

  async close(
    caller?: string,
    options: { restore?: boolean; retired?: boolean } = {},
  ): Promise<{ restored: boolean }> {
    const session = this.session;
    if (caller !== undefined && session?.caller !== caller) return { restored: false };
    this.cancelPending();
    ++this.generation;
    if (session) this.retire(session, options.retired);
    if (options.restore && session?.sourceToken && this.driver) {
      try {
        return { restored: (await this.driver.restoreSource(session.sourceToken)).ok };
      } catch {
        /* Native failures use fixed public results. */
      }
    }
    return { restored: false };
  }

  async returnToSource(caller: string): Promise<{ restored: boolean }> {
    const session = this.owned(caller);
    const driver = this.driver;
    if (!session?.sourceToken || !driver) return { restored: false };
    try {
      const result = await driver.restoreSource(session.sourceToken);
      if (!result.ok) return { restored: false };
      // A source TTL/focus failure must leave the view available for retry.
      // A successful old return must never retire a newer session using this caller.
      if (this.session === session) this.retire(session);
      return { restored: true };
    } catch {
      return { restored: false };
    }
  }

  beginExecution(caller: string): string | undefined {
    const session = this.owned(caller);
    if (!session) return;
    const executionId = (session.executionId = randomUUID());
    this.presentation = { caller, executionId, generation: this.generation };
    return executionId;
  }

  canPresent(caller: string, executionId: string): boolean {
    return (
      this.presentation?.caller === caller &&
      this.presentation.executionId === executionId &&
      this.presentation.generation === this.generation &&
      !this.stopped &&
      !this.options.isBlocked?.()
    );
  }

  endExecution(
    caller: string,
    result: { executionId: string; success: boolean; keepOpen?: boolean },
  ): void {
    const session = this.owned(caller);
    if (!session || session.executionId !== result.executionId) return;
    session.executionId = undefined;
    if (!result.success) this.presentation = undefined;
    if (result.success && !result.keepOpen) this.retire(session);
    else {
      try {
        this.options.focusView?.(caller);
      } catch {
        /* Context remains available for retry. */
      }
    }
  }

  blur(caller: string): void {
    const session = this.owned(caller);
    if (session && !session.executionId) void this.close(caller);
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    ++this.configurationGeneration;
    this.invalidate();
    this.setStatus("disabled");
    const work = this.lifecycle
      .catch(() => {})
      .then(async () => {
        if (this.driver) {
          await this.driver.stop();
          this.driver = undefined;
          ++this.driverGeneration;
        }
      });
    this.lifecycle = work;
    return work;
  }

  private owned(caller: string): Session | undefined {
    return this.session?.caller === caller ? this.session : undefined;
  }
  private current(pending: Pending): boolean {
    return (
      this.pending === pending &&
      pending.generation === this.generation &&
      !pending.abort.signal.aborted &&
      !this.stopped &&
      !this.options.isBlocked?.()
    );
  }
  private cancelPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.abort.abort();
  }
  private invalidate(): void {
    ++this.generation;
    this.cancelPending();
    if (this.session) this.retire(this.session);
  }
  private dispose(materialized: ContextPanelMaterialized): void {
    try {
      materialized.dispose();
    } catch {
      /* Revocation must finish even if a disposer fails. */
    }
  }
  private retire(session: Session, retired = false): void {
    if (this.session !== session) return;
    this.session = undefined; // External close callbacks can re-enter safely.
    const materialized = session.materialized;
    session.materialized = undefined;
    try {
      this.options.clearQuery(session.caller);
    } catch {
      /* Continue revoking the resource/window. */
    }
    if (materialized) this.dispose(materialized);
    if (!retired) {
      try {
        this.options.closeView(session.caller);
      } catch {
        /* Already retired internally. */
      }
    }
  }
  private open(
    point: Point,
    status: ContextPanelViewState["status"],
    reason: ContextPanelViewState["reason"],
  ): string {
    const caller = this.options.openView(point);
    const session: Session = {
      caller,
      state: {
        sessionId: randomUUID(),
        revision: ++this.revision,
        status,
        reason,
        returnAvailable: false,
      },
    };
    this.session = session;
    try {
      this.options.publish(caller, { ...session.state });
      if (this.session === session) this.options.focusView?.(caller);
    } catch {
      this.retire(session);
      throw new Error("Context panel view unavailable");
    }
    return caller;
  }
  private setStatus(phase: ContextPanelStatus["phase"]): void {
    this.statusValue = { supported: this.supported, phase };
    try {
      this.options.onStatus?.({ ...this.statusValue });
    } catch {
      /* Observers do not own native cleanup. */
    }
  }
  private sourceApp(value: string): string | undefined {
    return /^[^\\/]{1,260}$/u.test(value) &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ? value
      : undefined;
  }
  private suggestedQuery(value?: string): string | undefined {
    const word = value?.trim();
    return word && /^[a-z][a-z'-]{0,119}$/iu.test(word) ? word : undefined;
  }
  private reason(capture: ContextPanelNativeCapture): ContextPanelViewState["reason"] {
    if (capture.kind !== "none") return "empty";
    if (capture.reason === "emptySelection") return "empty";
    if (capture.reason === "timeout") return "timeout";
    if (["sourceChanged", "focusChanged"].includes(capture.reason)) return "changed";
    if (["protectedSource", "inputRejected"].includes(capture.reason)) return "denied";
    return "unavailable";
  }
}
