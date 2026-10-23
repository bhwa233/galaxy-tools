import { describe, it, expect } from "vitest";
import { deriveNoteWindowState, type NoteLayoutState } from "./note-window-state";
describe("note pin preference and desktop presence", () => {
  it("keeps an unopened pin independent of OS visibility and preserves it through fold/hide", () => {
    const layout: NoteLayoutState = {
      label: "notepad-a",
      noteId: "a",
      view: "notepad",
      bounds: { x: 0, y: 0, width: 360, height: 420 },
      visible: false,
      topmost: true,
      everOpened: false,
    };
    expect(deriveNoteWindowState("a", layout)).toMatchObject({
      pinned: true,
      presence: "unopened",
    });
    layout.everOpened = true;
    layout.visible = true;
    expect(deriveNoteWindowState("a", layout, true)).toMatchObject({
      pinned: true,
      presence: "desktop",
    });
    layout.folded = true;
    expect(deriveNoteWindowState("a", layout, false)).toMatchObject({
      pinned: true,
      presence: "capsule",
    });
    expect(deriveNoteWindowState("a", layout, false, true)).toMatchObject({
      pinned: true,
      presence: "hidden",
    });
    layout.visible = false;
    layout.topmost = false;
    expect(deriveNoteWindowState("a", layout)).toMatchObject({ pinned: false, presence: "hidden" });
    expect(deriveNoteWindowState("never-opened")).toMatchObject({
      pinned: false,
      presence: "unopened",
    });
  });
});
