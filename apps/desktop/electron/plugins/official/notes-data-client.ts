import type { JsonValue, PluginActivation } from "@spark233/sdk";
import type { NoteEditorMode, SaveNoteRequest } from "../../../src/features/notes/types.js";
import { AppError } from "../../persistence.js";
import type { PluginManager } from "../manager.js";
import {
  NOTES_DATA_VERSION,
  type NotesDataAction,
  type NotesDataParameters,
  type NotesDataResult,
} from "./notes-data-contract.js";

/** Host operations cross the live plugin manager; the utility owns all notes I/O. */
export class NotesDataClient {
  constructor(private readonly manager: () => Pick<PluginManager, "activate"> | undefined) {}

  /** Main may bind a separate client to one owner's startup/final-save transport. */
  static fromTransport(
    transport: (activation: PluginActivation) => Promise<JsonValue | undefined>,
  ): NotesDataClient {
    return new NotesDataClient(() => ({
      activate: (_pluginId, activation) => transport(activation),
    }));
  }

  private async call<A extends NotesDataAction>(
    action: A,
    parameters: NotesDataParameters[A],
  ): Promise<NotesDataResult<A>> {
    const manager = this.manager();
    if (!manager) throw new AppError("pluginDisabled", "便签插件当前不可用");
    const result = await manager.activate("spark233.notes", {
      commandId: "data",
      parameters: { version: NOTES_DATA_VERSION, action, ...parameters } as JsonValue,
    });
    if (result === undefined)
      throw new AppError("invalidPluginResponse", "便签后台没有返回数据操作结果");
    // Request and result types share the utility's versioned internal contract.
    return result as NotesDataResult<A>;
  }

  initialize(locale?: string) {
    return this.call("initialize", locale === undefined ? {} : { locale });
  }
  list(category?: string) {
    return this.call("note.list", category === undefined ? {} : { category });
  }
  history(id: string) {
    return this.call("note.history", { id });
  }
  revision(id: string, versionId: string) {
    return this.call("note.revision", { id, versionId });
  }
  restoreRevision(id: string, versionId: string, expectedRevision: string) {
    return this.call("note.restore", { id, versionId, expectedRevision });
  }
  get(id: string) {
    return this.call("note.get", { id });
  }
  save(request: SaveNoteRequest, id?: string) {
    return this.call("note.save", { request, ...(id === undefined ? {} : { id }) });
  }
  append(id: string, content: string) {
    return this.call("note.append", { id, content });
  }
  async delete(id: string): Promise<void> {
    await this.call("note.delete", { id });
  }
  setEditorMode(id: string, mode: NoteEditorMode) {
    return this.call("note.setEditorMode", { id, mode });
  }
  move(id: string, category: string) {
    return this.call("note.move", { id, category });
  }
  search(query: string, limit?: number) {
    return this.call("note.search", { query, ...(limit === undefined ? {} : { limit }) });
  }
  createFromImage(base64: string, extension: string, title?: string, category?: string) {
    return this.call("note.createFromImage", {
      base64,
      extension,
      ...(title === undefined ? {} : { title }),
      ...(category === undefined ? {} : { category }),
    });
  }
  categories() {
    return this.call("category.list", {});
  }
  async createCategory(name: string): Promise<void> {
    await this.call("category.create", { name });
  }
  async renameCategory(oldName: string, newName: string): Promise<void> {
    await this.call("category.rename", { oldName, newName });
  }
  async deleteCategory(name: string): Promise<void> {
    await this.call("category.delete", { name });
  }
  async saveImage(noteId: string, bytes: Uint8Array, extension: string) {
    return this.call("image.save", {
      noteId,
      base64: Buffer.from(bytes).toString("base64"),
      extension,
    });
  }
  cleanImages(noteId: string, content: string) {
    return this.call("image.clean", { noteId, content });
  }
  resolveImage(path: string) {
    return this.call("image.resolve", { path });
  }
  async saveBackgroundImage(bytes: Uint8Array, extension: string) {
    return this.call("image.saveBackground", {
      base64: Buffer.from(bytes).toString("base64"),
      extension,
    });
  }
  migrate(newDir: string) {
    return this.call("storage.migrate", { newDir });
  }
  getState(key: "layout" = "layout") {
    return this.call("state.get", { key });
  }
  async putState(key: "layout", value: JsonValue): Promise<void> {
    await this.call("state.put", { key, value });
  }
  listReminders(noteId?: string) {
    return this.call("reminder.list", noteId === undefined ? {} : { noteId });
  }
  setReminder(input: NotesDataParameters["reminder.set"]["input"]) {
    return this.call("reminder.set", { input });
  }
  setReminderPreset(input: NotesDataParameters["reminder.setPreset"]["input"]) {
    return this.call("reminder.setPreset", { input });
  }
  async cancelReminder(id: string): Promise<void> {
    await this.call("reminder.cancel", { id });
  }
  async cancelRemindersForNote(noteId: string): Promise<void> {
    await this.call("reminder.cancelForNote", { noteId });
  }
  tickReminders(now?: number) {
    return this.call("reminder.tick", now === undefined ? {} : { now });
  }
  async startReminders(): Promise<void> {
    await this.call("reminder.start", {});
  }
  async stopReminders(): Promise<void> {
    await this.call("reminder.stop", {});
  }
}
