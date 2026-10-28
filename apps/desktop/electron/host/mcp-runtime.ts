import { app } from "electron";
import type { McpOps } from "../mcp-protocol.js";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
export function createMcpOperations(
  ctx: Pick<
    RuntimeContext,
    | "notesClient"
    | "toMcpNote"
    | "enqueueMutation"
    | "changed"
    | "layouts"
    | "windows"
    | "persistLayout"
  >,
): McpOps {
  return {
    version: () => app.getVersion(),
    listCategories: () => ctx.notesClient.categories(),
    listNotes: async (category) =>
      (await ctx.notesClient.list(category)).map(
        ({ id, title, category, updatedAt, wordCount }) => ({
          id,
          title,
          category,
          updatedAt,
          wordCount,
        }),
      ),
    readNote: async (id) => ctx.toMcpNote(await ctx.notesClient.get(id)),
    searchNotes: async (query, limit) =>
      (await ctx.notesClient.search(query, limit)).map(({ id, title, snippet }) => ({
        id,
        title,
        snippet,
      })),
    createNote: (input) =>
      ctx.enqueueMutation(async () => {
        const note = await ctx.notesClient.save({
          title: input.title ?? "",
          content: input.content ?? "",
          category: input.category ?? "",
        });
        ctx.changed();
        return ctx.toMcpNote(note);
      }),
    writeNote: (id, mode, content) =>
      ctx.enqueueMutation(async () => {
        const note = mode === "replace" ? await ctx.notesClient.get(id) : undefined;
        const saved = note
          ? await ctx.notesClient.save({ title: note.title, content, category: note.category }, id)
          : await ctx.notesClient.append(id, content);
        ctx.changed();
        return ctx.toMcpNote(saved);
      }),
    deleteNote: (id) =>
      ctx.enqueueMutation(async () => {
        const editors = [...ctx.layouts.values()].filter(
          (entry) => entry.noteId === id && ctx.windows.has(entry.label),
        );
        if (editors.length)
          throw new AppError("noteInUse", "该便签有独立窗口打开，请先关闭后再删除");
        await ctx.notesClient.delete(id);
        await ctx.notesClient.cancelRemindersForNote(id);
        for (const entry of ctx.layouts.values())
          if (entry.noteId === id) ctx.layouts.delete(entry.label);
        await ctx.persistLayout();
        ctx.changed();
      }),
    setReminder: (input) =>
      ctx.enqueueMutation(async () => {
        let noteId = input.noteId;
        if (!noteId && input.title) {
          const found = (await ctx.notesClient.list()).find((note) => note.title === input.title);
          if (!found) throw new AppError("noteNotFound", `找不到标题为「${input.title}」的便签`);
          noteId = found.id;
        }
        if (!noteId) throw new AppError("invalidPayload", "需要 noteId 或 title 定位便签");
        const fireAt =
          input.fireAt ??
          (input.minutes && input.minutes > 0
            ? new Date(Date.now() + input.minutes * 60_000).toISOString()
            : undefined);
        if (!fireAt) throw new AppError("invalidPayload", "需要 minutes 或 fireAt 指定提醒时间");
        return ctx.notesClient.setReminder({ noteId, fireAt, taskText: input.taskText });
      }),
  };
}
