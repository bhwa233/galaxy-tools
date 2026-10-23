import { invoke } from "../../platform/desktop";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function openNotepadWindow(noteId?: string, bounds?: WindowBounds): Promise<string> {
  return invoke("open_notepad_window", {
    noteId: noteId ?? null,
    bounds: bounds ?? null,
  });
}

export function openTileWindow(noteId: string, bounds?: WindowBounds): Promise<string> {
  return invoke("open_tile_window", { noteId, bounds: bounds ?? null });
}

export function toggleTileWindow(noteId: string, bounds?: WindowBounds): Promise<boolean> {
  return invoke("toggle_tile_window", { noteId, bounds: bounds ?? null });
}

export function openNoteInEditor(noteId: string): Promise<void> {
  return invoke("open_note_in_editor", { noteId });
}

export function takeStartupFile(): Promise<string | null> {
  return invoke("take_startup_file");
}

/** Show the same saved note, retaining its current desktop view and reusing its window. */
export function showNoteOnDesktop(noteId: string): Promise<string> {
  return invoke("show_note_on_desktop", { noteId });
}

export function setNotePinned(noteId: string, pinned: boolean): Promise<void> {
  return invoke("note_set_pinned", { noteId, pinned });
}
export function hideNoteOnDesktop(noteId: string): Promise<void> {
  return invoke("hide_note_on_desktop", { noteId });
}
