import type { SaveState } from "./notePresentation";

/** A draft that is not yet durably saved: edited, being written, or failed. */
export function isUnsaved(state: SaveState): boolean {
  return state === "dirty" || state === "saving" || state === "error";
}
