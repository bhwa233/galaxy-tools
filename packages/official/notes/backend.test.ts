import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import notesBackend from "./backend.ts";
import type { BackendContext } from "../../../apps/desktop/electron/plugins/backend-worker.js";
import type {
  NotesDataAction,
  NotesDataParameters,
  NotesDataResult,
} from "../../../apps/desktop/electron/plugins/official/notes-data-contract.js";
import type { JsonValue } from "@spark233/sdk";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Reuse the actual backend's versioned data entry and durable engines; only the
// host effects and events are controlled, with every file confined to this fixture.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-notes-backend-"));
  const dataDir = path.join(root, "data"),
    cacheDir = path.join(root, "cache");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(cacheDir);
  const emit = vi.fn<BackendContext["emit"]>();
  const callHost = vi.fn<BackendContext["callHost"]>(async () => {
    throw new Error("Unexpected host effect");
  });
  const sessions: Array<() => Promise<void>> = [];
  function open() {
    const lifetime = new AbortController();
    const context: BackendContext = {
      owner: { pluginId: "spark233.notes", version: "0.1.2", instanceId: randomUUID() },
      dataDir,
      cacheDir,
      signal: lifetime.signal,
      startupCheckOnly: false,
      emit,
      callHost,
    };
    const backend = notesBackend(context);
    let closed = false;
    const close = async () => {
      if (closed) return;
      const decision = await backend.prepareStop("quit", context);
      if (!decision.ok) throw new Error(decision.reason);
      await backend.stop?.(context);
      lifetime.abort();
      closed = true;
    };
    sessions.push(close);
    const call = async <A extends NotesDataAction>(
      action: A,
      parameters: NotesDataParameters[A],
    ): Promise<NotesDataResult<A>> =>
      (await backend.activate!(
        { commandId: "data", parameters: { version: 1, action, ...parameters } as JsonValue },
        context,
      )) as NotesDataResult<A>;
    return { call, close };
  }
  cleanups.push(async () => {
    try {
      for (const close of sessions) await close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, dataDir, emit, callHost, open };
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5F8AAAAASUVORK5CYII=",
  "base64",
);

test("notes backend persists committed Markdown, attachment references and search across restart", async () => {
  const f = fixture(),
    first = f.open();
  await first.call("initialize", { locale: "zh-CN" });
  await first.call("category.create", { name: "工作" });
  const created = await first.call("note.save", {
    request: { title: "项目资料", content: "# 保留原文", category: "工作", editorMode: "markdown" },
  });
  const image = await first.call("image.save", {
    noteId: created.id,
    base64: png.toString("base64"),
    extension: "png",
  });
  const markdown = `# 保留原文\n\n![](${image})\n\n**KEEP-中文**`;
  await first.call("note.save", { id: created.id, request: { ...created, content: markdown } });
  const committed = await first.call("note.append", { id: created.id, content: "追加内容" });
  expect(committed).toMatchObject({
    id: created.id,
    createdAt: created.createdAt,
    category: "工作",
    editorMode: "markdown",
    content: `${markdown}\n追加内容`,
  });
  const hits = await first.call("note.search", { query: "keep-中文" });
  expect(hits.map((hit) => hit.id)).toEqual([created.id]);
  expect(hits[0].snippet).toContain("KEEP-中文");
  expect(fs.readFileSync(await first.call("image.resolve", { path: image }))).toEqual(png);
  await first.close();

  const restarted = f.open();
  await restarted.call("initialize", { locale: "zh-CN" });
  expect(await restarted.call("note.get", { id: created.id })).toEqual(committed);
  expect((await restarted.call("note.list", { category: "工作" })).map((note) => note.id)).toEqual([
    created.id,
  ]);
  expect(fs.readFileSync(await restarted.call("image.resolve", { path: image }))).toEqual(png);
  expect((await restarted.call("note.search", { query: "追加内容" }))[0].id).toBe(created.id);
  expect(f.callHost).not.toHaveBeenCalled();
});

test("host trash refusal preserves note, metadata, attachment and reminders until deletion succeeds", async () => {
  const f = fixture(),
    session = f.open();
  const note = await session.call("note.save", {
    request: { title: "不能丢失", content: "# 回收前原文", category: "" },
  });
  const image = await session.call("image.save", {
    noteId: note.id,
    base64: png.toString("base64"),
    extension: "png",
  });
  const reminder = await session.call("reminder.set", {
    input: {
      noteId: note.id,
      fireAt: new Date(Date.now() + 60_000).toISOString(),
      taskText: "保留提醒",
    },
  });
  const bodyFile = path.join(f.dataDir, "notes", note.fileName);
  const metadataFile = path.join(f.dataDir, "metadata.json");
  const reminderFile = path.join(f.dataDir, "reminders.json");
  const before = [bodyFile, metadataFile, reminderFile].map((file) => fs.readFileSync(file));
  f.emit.mockClear();
  f.callHost.mockRejectedValueOnce(new Error("OWN_TRASH_REFUSED"));
  await expect(session.call("note.delete", { id: note.id })).rejects.toThrow("OWN_TRASH_REFUSED");
  expect([bodyFile, metadataFile, reminderFile].map((file) => fs.readFileSync(file))).toEqual(
    before,
  );
  expect(await session.call("note.get", { id: note.id })).toEqual(note);
  expect(await session.call("reminder.list", { noteId: note.id })).toEqual([reminder]);
  expect(f.emit).not.toHaveBeenCalled();

  const recycled = path.join(f.root, "owned-trash", note.fileName);
  f.callHost.mockImplementationOnce(async (call) => {
    expect(call).toEqual({ operation: "file.trash", path: `notes/${note.fileName}` });
    fs.mkdirSync(path.dirname(recycled));
    fs.renameSync(path.join(f.dataDir, call.path), recycled);
  });
  await expect(session.call("note.delete", { id: note.id })).resolves.toBeNull();
  expect(fs.readFileSync(recycled)).toEqual(before[0]);
  expect(fs.existsSync(bodyFile)).toBe(false);
  expect(await session.call("note.list", {})).toEqual([]);
  await expect(session.call("note.get", { id: note.id })).rejects.toMatchObject({
    code: "noteNotFound",
  });
  expect(await session.call("reminder.list", { noteId: note.id })).toEqual([]);
  expect(JSON.parse(fs.readFileSync(reminderFile, "utf8")).items).toEqual([]);
  // Removing a note retains its attachment so recovery from the OS trash is possible.
  expect(fs.readFileSync(path.join(f.dataDir, image))).toEqual(png);
  expect(f.emit).toHaveBeenCalledWith("notes-data-changed", { action: "note.delete" });
});
