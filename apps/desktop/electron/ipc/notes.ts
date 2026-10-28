import { z } from "zod";
import type { NotesDataClient } from "../plugins/official/notes-data-client.js";

const identifier = z.string().min(1).max(512);
/** Document I/O belongs to the notes client; window ownership stays in main. */
export function createNotesCommands(data: NotesDataClient, changed: () => void) {
  return {
    notes_list: () => data.list(),
    notes_get: (args: Record<string, unknown>) => data.get(identifier.parse(args.id)),
    categories_list: () => data.categories(),
    categories_create: async (args: Record<string, unknown>) => {
      await data.createCategory(z.string().parse(args.name));
      changed();
    },
    categories_rename: async (args: Record<string, unknown>) => {
      await data.renameCategory(z.string().parse(args.oldName), z.string().parse(args.newName));
      changed();
    },
    categories_delete: async (args: Record<string, unknown>) => {
      await data.deleteCategory(z.string().parse(args.name));
      changed();
    },
    notes_move_category: async (args: Record<string, unknown>) => {
      const result = await data.move(identifier.parse(args.id), z.string().parse(args.category));
      changed();
      return result;
    },
    notes_set_editor_mode: async (args: Record<string, unknown>) => {
      const result = await data.setEditorMode(
        identifier.parse(args.id),
        z.enum(["markdown", "text"]).parse(args.mode),
      );
      changed();
      return result;
    },
    images_clean_unused: (args: Record<string, unknown>) =>
      data.cleanImages(identifier.parse(args.noteId), z.string().parse(args.content)),
  };
}
