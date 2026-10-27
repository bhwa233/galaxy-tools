import { invoke } from "../../platform/desktop";
import { describe, expect, test, vi } from "vitest";
import { openNotepadWindow, openTileWindow, toggleTileWindow, type WindowBounds } from "./api";

vi.mock("../../platform/desktop", () => ({
  invoke: vi.fn(),
}));

describe("window api", () => {
  test("passes optional bounds when opening tile and notepad windows", async () => {
    const bounds: WindowBounds = { x: 12, y: 34, width: 320, height: 240 };
    vi.mocked(invoke).mockResolvedValue("ok");

    await openTileWindow("note-1", bounds);
    await openNotepadWindow("note-1", bounds);

    expect(invoke).toHaveBeenNthCalledWith(1, "open_tile_window", {
      noteId: "note-1",
      bounds,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "open_notepad_window", {
      noteId: "note-1",
      bounds,
    });
  });

  test("toggles a tile window for a note", async () => {
    vi.mocked(invoke).mockResolvedValue(false);

    await expect(toggleTileWindow("note-1")).resolves.toBe(false);

    expect(invoke).toHaveBeenCalledWith("toggle_tile_window", {
      noteId: "note-1",
      bounds: null,
    });
  });
});
