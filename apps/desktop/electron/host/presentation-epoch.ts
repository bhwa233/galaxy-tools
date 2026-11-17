import type { BrowserWindow } from "electron";
import type { StopDecision } from "../plugins/resources.js";

const presentations = new WeakMap<BrowserWindow, number>();
let intent = 0;
let exclusive: { cancel: () => Promise<StopDecision> } | undefined;

/** Explicit user actions replace the restoration intent of earlier tasks. */
export function supersedePresentation(): void {
  intent++;
}

export function presentationGuard(): () => boolean {
  const current = intent;
  return () => current === intent;
}

export function registerExclusivePresentation(cancel: () => Promise<StopDecision>): () => void {
  const task = { cancel };
  exclusive = task;
  return () => {
    if (exclusive === task) exclusive = undefined;
  };
}

export async function cancelExclusivePresentation(): Promise<void> {
  const task = exclusive;
  if (!task) return;
  try {
    const decision = await task.cancel();
    if (!decision.ok) console.error("exclusive-task-cancel", decision.reason);
  } catch (error) {
    console.error("exclusive-task-cancel", error);
  } finally {
    if (exclusive === task) exclusive = undefined;
  }
}

/** Records that the user asked to see a window right now. A close that is still
 * waiting for its save acknowledgement compares this counter before mutating
 * layout or hiding, so a re-open during the wait wins over the stale close. */
export function markPresented(win: BrowserWindow): void {
  presentations.set(win, (presentations.get(win) ?? 0) + 1);
}

export function presentationCount(win: BrowserWindow): number {
  return presentations.get(win) ?? 0;
}
