import type { JsonValue } from "@spark233/sdk";
import type {
  Note,
  NoteMetadata,
  SaveNoteRequest,
  NoteEditorMode,
} from "../../../src/features/notes/types.js";
import type { ReminderItem } from "../../../src/features/reminders/types.js";
import type { ReminderPresetId } from "../../../src/features/reminders/presets.js";

export const NOTES_DATA_VERSION = 1;
export interface NoteSearchHit extends NoteMetadata {
  snippet: string;
}
export interface NotesDataParameters {
  initialize: { locale?: string };
  "note.list": { category?: string };
  "note.get": { id: string };
  "note.save": { request: SaveNoteRequest; id?: string };
  "note.append": { id: string; content: string };
  "note.delete": { id: string };
  "note.setEditorMode": { id: string; mode: NoteEditorMode };
  "note.move": { id: string; category: string };
  "note.search": { query: string; limit?: number };
  "note.createFromImage": { base64: string; extension: string; title?: string; category?: string };
  "category.list": Record<never, never>;
  "category.create": { name: string };
  "category.rename": { oldName: string; newName: string };
  "category.delete": { name: string };
  "image.save": { noteId: string; base64: string; extension: string };
  "image.clean": { noteId: string; content: string };
  "image.resolve": { path: string };
  "image.saveBackground": { base64: string; extension: string };
  "storage.migrate": { newDir: string };
  "state.get": { key: "layout" };
  "state.put": { key: "layout"; value: JsonValue };
  "reminder.list": { noteId?: string };
  "reminder.set": { input: { noteId: string; fireAt: string; taskText?: string } };
  "reminder.setPreset": { input: { noteId: string; preset: ReminderPresetId; taskText?: string } };
  "reminder.cancel": { id: string };
  "reminder.cancelForNote": { noteId: string };
  "reminder.tick": { now?: number };
  "reminder.start": Record<never, never>;
  "reminder.stop": Record<never, never>;
}
export interface NotesDataResults {
  initialize: { version: 1 };
  "note.list": NoteMetadata[];
  "note.get": Note;
  "note.save": Note;
  "note.append": Note;
  "note.delete": null;
  "note.setEditorMode": NoteMetadata;
  "note.move": NoteMetadata;
  "note.search": NoteSearchHit[];
  "note.createFromImage": Note;
  "category.list": string[];
  "category.create": null;
  "category.rename": null;
  "category.delete": null;
  "image.save": string;
  "image.clean": string[];
  "image.resolve": string;
  "image.saveBackground": string;
  "storage.migrate": string;
  "state.get": JsonValue;
  "state.put": null;
  "reminder.list": ReminderItem[];
  "reminder.set": ReminderItem;
  "reminder.setPreset": ReminderItem;
  "reminder.cancel": null;
  "reminder.cancelForNote": null;
  "reminder.tick": ReminderItem[];
  "reminder.start": null;
  "reminder.stop": null;
}
export type NotesDataAction = keyof NotesDataParameters;
export type NotesDataRequest<A extends NotesDataAction = NotesDataAction> = {
  [K in A]: { version: 1; action: K } & NotesDataParameters[K];
}[A];
export type NotesDataResult<A extends NotesDataAction> = NotesDataResults[A];
