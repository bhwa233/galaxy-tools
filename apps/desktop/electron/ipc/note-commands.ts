import fs from "node:fs";
import path from "node:path";
import type { SaveNoteRequest } from "../../src/features/notes/types.js";
import { createNotesCommands } from "../ipc/notes.js";
import { AppError, atomicWrite } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { text } from "./arguments.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createNoteCommands(
  ctx: Pick<
    RuntimeContext,
    | "notesActive"
    | "requireNotes"
    | "notesScope"
    | "preparedWindows"
    | "notesMaintenanceClient"
    | "notesClient"
    | "changed"
    | "layouts"
    | "windows"
    | "persistLayout"
    | "TEXT_FILE"
    | "hostConfig"
    | "IMAGE_FILE"
    | "publishNoteStates"
    | "noteWindowSnapshot"
    | "setNotePinned"
    | "hideNoteOnDesktop"
    | "openNote"
    | "hideAndRelease"
    | "paperMenu"
    | "foldAndRelease"
    | "openNoteWithAnchor"
    | "startupFile"
  >,
) {
  async function run({
    win,
    command,
    args,
    layout,
    grants,
    preparationWrite,
  }: CommandInvocation): Promise<unknown> {
    if (
      !ctx.notesActive &&
      /^(notes_|categories_|images_|reminders_|note_|open_notepad|open_tile|show_note|hide_note|toggle_tile|open_note)/.test(
        command,
      )
    )
      ctx.requireNotes();
    const data =
      preparationWrite &&
      ctx.notesScope?.state === "preparing" &&
      layout.view !== "launcher" &&
      !ctx.preparedWindows.has(win.id)
        ? (ctx.notesMaintenanceClient ?? ctx.notesClient)
        : ctx.notesClient;
    const noteCommands = createNotesCommands(data, ctx.changed);
    if (Object.hasOwn(noteCommands, command))
      return noteCommands[command as keyof typeof noteCommands](args);
    switch (command) {
      case "notes_create": {
        const note = await data.save(args.request as SaveNoteRequest);
        if ((layout.view === "notepad" || layout.view === "tile") && !layout.noteId)
          layout.noteId = note.id;
        ctx.changed();
        return note;
      }
      case "notes_update": {
        const note = await data.save(args.request as SaveNoteRequest, text(args.id));
        ctx.changed();
        return note;
      }
      case "notes_delete": {
        const id = text(args.id);
        const editors = [...ctx.layouts.values()].filter(
          (entry) => entry.noteId === id && ctx.windows.has(entry.label),
        );
        if (editors.length) throw new AppError("noteInUse", "请先关闭该便签的独立窗口再删除");
        await data.delete(id);
        for (const entry of ctx.layouts.values())
          if (entry.noteId === id) ctx.layouts.delete(entry.label);
        await ctx.persistLayout();
        ctx.changed();
        return;
      }
      case "notes_import_markdown": {
        const file = grants.assert(args.path, /\.md$/i),
          content = fs.readFileSync(file, "utf8");
        const note = await data.save({
          title:
            content.match(/^\s*# (.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file)),
          content,
          category: args.category || "",
        });
        ctx.changed();
        return note;
      }
      case "notes_export_markdown":
        atomicWrite(grants.assert(args.path, /\.md$/i), (await data.get(text(args.id))).content);
        return;
      case "read_external_file":
        return fs.readFileSync(grants.assert(args.path, ctx.TEXT_FILE), "utf8");
      case "get_file_modified_time":
        return fs.statSync(grants.assert(args.path, ctx.TEXT_FILE)).mtimeMs;
      case "save_external_file":
        atomicWrite(grants.assert(args.path, ctx.TEXT_FILE), text(args.content));
        return;
      case "images_get_base_dir":
        return ctx.hostConfig.value.dataDir;
      case "images_save":
        return data.saveImage(
          text(args.headers?.["x-note-id"]),
          args.data,
          text(args.headers?.["x-image-ext"]),
        );
      case "images_save_from_path": {
        const file = grants.assert(args.filePath, ctx.IMAGE_FILE);
        return data.saveImage(
          text(args.noteId),
          fs.readFileSync(file),
          path.extname(file).slice(1),
        );
      }
      case "copy_background_image": {
        const file = grants.assert(args.sourcePath, ctx.IMAGE_FILE);
        return data.saveBackgroundImage(fs.readFileSync(file), path.extname(file).slice(1));
      }
      case "note_window_states":
        ctx.publishNoteStates();
        return ctx.noteWindowSnapshot();
      case "note_set_pinned":
        if (typeof args.pinned !== "boolean")
          throw new AppError("invalidPayload", "置顶参数不合法");
        await ctx.setNotePinned(text(args.noteId), args.pinned);
        return;
      case "reminders_list":
        return data.listReminders();
      case "reminders_set": {
        const taskText = args.taskText === undefined ? undefined : text(args.taskText);
        return data.setReminder({
          noteId: text(args.noteId),
          fireAt: text(args.fireAt),
          taskText,
        });
      }
      case "reminders_cancel":
        await data.cancelReminder(text(args.id));
        return;
      case "hide_note_on_desktop":
        await ctx.hideNoteOnDesktop(text(args.noteId));
        return;
      case "show_note_on_desktop":
        return ctx.openNote(text(args.noteId));
      case "open_notepad_window":
        return ctx.openNote(args.noteId ?? undefined, "notepad", args.bounds ?? undefined);
      case "open_tile_window":
        return ctx.openNote(text(args.noteId), "tile", args.bounds ?? undefined);
      case "toggle_tile_window": {
        const id = text(args.noteId),
          entry = [...ctx.layouts.values()].find(
            (item) => item.noteId === id && item.view === "tile" && item.visible,
          );
        if (entry) {
          const other = ctx.windows.get(entry.label);
          if (other) await ctx.hideAndRelease(other);
          else {
            entry.visible = false;
            await ctx.persistLayout();
          }
          return false;
        }
        await ctx.openNote(id, "tile", args.bounds ?? undefined);
        return true;
      }
      case "note_context_menu":
        if (layout.view === "main") return;
        (await ctx.paperMenu(win)).popup({ window: win });
        return;
      case "fold_note_window":
        if (layout.view !== "main") await ctx.foldAndRelease(win);
        return;
      case "recycle_notepad_window":
        await ctx.hideAndRelease(win);
        return;
      case "open_note_in_editor": {
        const id = text(args.noteId);
        await ctx.openNoteWithAnchor(id);
        return;
      }
      case "take_startup_file": {
        const file = ctx.startupFile;
        if (file) grants.grant(file);
        ctx.startupFile = null;
        return file;
      }
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    categories_create: run,
    categories_delete: run,
    categories_list: run,
    categories_rename: run,
    copy_background_image: run,
    fold_note_window: run,
    get_file_modified_time: run,
    hide_note_on_desktop: run,
    images_clean_unused: run,
    images_get_base_dir: run,
    images_save: run,
    images_save_from_path: run,
    note_context_menu: run,
    note_set_pinned: run,
    note_window_states: run,
    notes_create: run,
    notes_delete: run,
    notes_export_markdown: run,
    notes_get: run,
    notes_import_markdown: run,
    notes_list: run,
    notes_move_category: run,
    notes_set_editor_mode: run,
    notes_update: run,
    open_note_in_editor: run,
    open_notepad_window: run,
    open_tile_window: run,
    read_external_file: run,
    recycle_notepad_window: run,
    reminders_cancel: run,
    reminders_list: run,
    reminders_set: run,
    save_external_file: run,
    show_note_on_desktop: run,
    take_startup_file: run,
    toggle_tile_window: run,
  } satisfies Record<string, CommandHandler>;
}
