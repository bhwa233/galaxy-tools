import type { CapsuleEntry } from "../src/features/capsules/types.js";
import type { NoteWindowState } from "../src/features/windows/noteWindowState.js";
export type NoteLayoutState = CapsuleEntry & {
  topmost: boolean;
  everOpened?: boolean;
  view: "main" | "launcher" | "notepad" | "tile";
};
/** The saved pin preference is independent of transient OS z-order and capsule topmost. */
export function deriveNoteWindowState(
  noteId: string,
  layout?: NoteLayoutState,
  nativeVisible = false,
  capsulesHidden = false,
): NoteWindowState {
  const state: NoteWindowState = {
    noteId,
    pinned: layout?.topmost ?? false,
    presence: "unopened",
    view: layout?.view === "tile" ? "tile" : "notepad",
  };
  if (!layout || layout.everOpened === false) return state;
  state.presence = !layout.visible
    ? "hidden"
    : layout.folded
      ? capsulesHidden
        ? "hidden"
        : "capsule"
      : nativeVisible
        ? "desktop"
        : "hidden";
  return state;
}
