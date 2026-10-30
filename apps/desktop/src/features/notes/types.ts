export type NoteEditorMode = "markdown" | "text";
export const DEFAULT_NOTE_EDITOR_MODE: NoteEditorMode = "text";
export const NOTE_TITLE_MAX_LENGTH = 12;

export interface NoteMetadata {
  id: string;
  title: string;
  fileName: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  preview: string;
  editorMode?: NoteEditorMode;
}

export interface Note extends Omit<NoteMetadata, "preview"> {
  content: string;
}

export interface SaveNoteRequest {
  editorMode?: NoteEditorMode;
  title: string;
  content: string;
  category: string;
}

export interface ExternalFile {
  id: string;
  title: string;
  filePath: string;
}

export interface NoteHistory {
  entries: Array<{ versionId: string; savedAt: string; title: string; bytes: number }>;
  currentRevision: string;
}
