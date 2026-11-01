import { randomUUID } from "node:crypto";
import type { WidgetBinding } from "@spark233/sdk";

export interface WidgetOpenMainCandidate {
  candidateId: string;
  cardId: string;
  surfaceId: string;
  requestId: string;
  actionId: string;
  binding: WidgetBinding;
  expiresAt: number;
}
interface PendingOpenMain {
  candidate: WidgetOpenMainCandidate;
  current: () => boolean;
  finish: (error?: Error) => void;
}

/** A child can propose navigation, but only a fresh trusted-shell gesture can
 * consume its short-lived candidate. This gate never opens a window itself. */
export class WidgetOpenMainGate {
  private pending = new Map<string, PendingOpenMain>();
  constructor(private readonly closed: (candidate: WidgetOpenMainCandidate) => void) {}
  request(
    input: Omit<WidgetOpenMainCandidate, "candidateId" | "expiresAt">,
    signal: AbortSignal,
    current: () => boolean,
  ): { candidate: WidgetOpenMainCandidate; confirmed: Promise<void> } {
    signal.throwIfAborted();
    if (!current()) throw new Error("widget.staleBinding");
    if ([...this.pending.values()].some((value) => value.candidate.cardId === input.cardId))
      throw new Error("widget.rateLimited");
    const candidate: WidgetOpenMainCandidate = {
      ...input,
      binding: structuredClone(input.binding),
      candidateId: randomUUID(),
      expiresAt: Date.now() + 10000,
    };
    let entry: PendingOpenMain;
    const confirmed = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (this.pending.get(candidate.candidateId) !== entry) return;
        this.pending.delete(candidate.candidateId);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        try {
          this.closed(candidate);
        } catch {
          /* A vanished shell cannot retain the candidate. */
        }
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(
          new Error(
            signal.reason instanceof Error && signal.reason.message === "widget.timeout"
              ? "widget.timeout"
              : "widget.cancelled",
          ),
        );
      const timer = setTimeout(() => finish(new Error("widget.timeout")), 10000);
      timer.unref();
      entry = { candidate, current, finish };
      this.pending.set(candidate.candidateId, entry);
      signal.addEventListener("abort", abort, { once: true });
    });
    return { candidate, confirmed };
  }
  confirm(
    candidateId: string,
    cardId: string,
    surfaceId: string,
    allow: boolean,
    userGesture: boolean,
  ): void {
    const entry = this.pending.get(candidateId);
    if (
      !entry ||
      entry.candidate.cardId !== cardId ||
      entry.candidate.surfaceId !== surfaceId ||
      !userGesture
    )
      throw new Error("widget.commandDenied");
    if (Date.now() >= entry.candidate.expiresAt) {
      entry.finish(new Error("widget.timeout"));
      throw new Error("widget.timeout");
    }
    if (!entry.current()) {
      entry.finish(new Error("widget.staleBinding"));
      throw new Error("widget.staleBinding");
    }
    entry.finish(allow ? undefined : new Error("widget.cancelled"));
  }
  dispose(): void {
    for (const value of this.pending.values()) value.finish(new Error("widget.cancelled"));
  }
}
