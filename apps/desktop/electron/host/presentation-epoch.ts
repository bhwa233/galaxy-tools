import type { BrowserWindow } from "electron";

const presentations = new WeakMap<BrowserWindow, number>();

/** Records that the user asked to see a window right now. A close that is still
 * waiting for its save acknowledgement compares this counter before mutating
 * layout or hiding, so a re-open during the wait wins over the stale close. */
export function markPresented(win: BrowserWindow): void {
  presentations.set(win, (presentations.get(win) ?? 0) + 1);
}

export function presentationCount(win: BrowserWindow): number {
  return presentations.get(win) ?? 0;
}
