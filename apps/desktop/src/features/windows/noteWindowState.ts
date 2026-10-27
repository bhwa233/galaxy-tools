export type NoteDesktopPresence = "unopened" | "desktop" | "capsule" | "hidden";
export interface NoteWindowState {
  noteId: string;
  pinned: boolean;
  presence: NoteDesktopPresence;
  view: "notepad" | "tile";
}
export interface NoteWindowSnapshot {
  version: number;
  notes: NoteWindowState[];
}
export const NOTE_WINDOW_STATES_CHANGED = "note-window-states-changed";
