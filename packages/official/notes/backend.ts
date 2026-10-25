import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NoteStore, AppError, atomicWrite, confined, readJson } from "../../../electron/store.js";
import { defaultConfig } from "../../../electron/host-config.js";
import { imagePath } from "../../../electron/security.js";
import { Reminders, REMINDER_TICK_MS } from "../../../electron/reminders.js";
import type { BackendContext, BackendPlugin } from "../../../electron/plugins/backend-worker.js";
import type {
  NotesDataAction,
  NotesDataRequest,
} from "../../../electron/plugins/official/notes-data-contract.js";
import type { JsonValue, PluginActivation } from "../../../packages/sdk/src/index.js";
import { REMINDER_PRESETS } from "../../../src/features/reminders/presets.js";

const id = z.string().min(1).max(100),
  text = z.string().max(16 * 1024 * 1024);
const save = z.object({
  title: z.string(),
  content: text,
  category: z.string(),
  editorMode: z.enum(["text", "markdown"]).optional(),
});
const image = { base64: z.string().max(45 * 1024 * 1024), extension: z.string().max(8) };
const schemas = {
  initialize: z.object({ locale: z.string().max(20).optional() }),
  "note.list": z.object({ category: z.string().optional() }),
  "note.get": z.object({ id }),
  "note.save": z.object({ request: save, id: id.optional() }),
  "note.append": z.object({ id, content: text }),
  "note.delete": z.object({ id }),
  "note.setEditorMode": z.object({ id, mode: z.enum(["text", "markdown"]) }),
  "note.move": z.object({ id, category: z.string() }),
  "note.search": z.object({
    query: z.string().max(8192),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  "note.createFromImage": z.object({
    ...image,
    title: z.string().optional(),
    category: z.string().optional(),
  }),
  "category.list": z.object({}),
  "category.create": z.object({ name: z.string() }),
  "category.rename": z.object({ oldName: z.string(), newName: z.string() }),
  "category.delete": z.object({ name: z.string() }),
  "image.save": z.object({ noteId: id, ...image }),
  "image.clean": z.object({ noteId: id, content: text }),
  "image.resolve": z.object({ path: z.string().max(32768) }),
  "image.saveBackground": z.object(image),
  "storage.migrate": z.object({ newDir: z.string().max(32768) }),
  "state.get": z.object({ key: z.literal("layout") }),
  "state.put": z.object({
    key: z.literal("layout"),
    value: z
      .json()
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024,
        "Layout state exceeds 1 MiB",
      ),
  }),
  "reminder.list": z.object({ noteId: id.optional() }),
  "reminder.set": z.object({
    input: z.object({ noteId: id, fireAt: z.string(), taskText: z.string().optional() }),
  }),
  "reminder.setPreset": z.object({
    input: z.object({ noteId: id, preset: z.string(), taskText: z.string().optional() }),
  }),
  "reminder.cancel": z.object({ id }),
  "reminder.cancelForNote": z.object({ noteId: id }),
  "reminder.tick": z.object({ now: z.number().int().nonnegative().optional() }),
  "reminder.start": z.object({}),
  "reminder.stop": z.object({}),
} satisfies Record<NotesDataAction, z.ZodType>;

function parse(value: unknown): NotesDataRequest {
  const envelope = z
    .object({ version: z.literal(1), action: z.string() })
    .passthrough()
    .parse(value);
  if (!Object.hasOwn(schemas, envelope.action))
    throw new AppError("invalidPayload", "Unknown notes data action");
  const { version, action, ...parameters } = envelope;
  return {
    ...schemas[action as NotesDataAction].parse(parameters),
    version,
    action,
  } as NotesDataRequest;
}
function bytes(base64: string): Buffer {
  const result = Buffer.from(base64, "base64");
  if (result.length > 32 * 1024 * 1024 || result.toString("base64") !== base64)
    throw new AppError("unsupportedImageFormat", "Invalid image or image exceeds 32 MiB");
  return result;
}

// Reuse the existing durable engine and reminder rules, bundled into this
// package. Only this worker interprets Markdown paths, metadata and image refs.
export default function notesBackend(lifetime: BackendContext): BackendPlugin {
  let current: BackendContext | undefined,
    initialized = false,
    locale = "zh-CN";
  let queue: Promise<unknown> = Promise.resolve(),
    timer: ReturnType<typeof setInterval> | undefined;
  const settings = {
    value: defaultConfig(lifetime.dataDir),
    save: (value: ReturnType<typeof defaultConfig>) => {
      settings.value = value;
      return value;
    },
  };
  const store = new NoteStore(
    path.join(lifetime.cacheDir, "notes-engine"),
    lifetime.dataDir,
    async (file) => {
      if (!current) throw new AppError("permissionDenied", "Trash requires a live data operation");
      await current.callHost({
        operation: "file.trash",
        path: path.relative(lifetime.dataDir, file).replaceAll("\\", "/"),
      });
    },
    settings,
    { initialize: false },
  );
  const reminders = new Reminders({
    file: () => confined(lifetime.dataDir, "reminders.json"),
    getNote: (noteId) => store.get(noteId),
    getLocale: () => locale,
    notify: (notification) =>
      lifetime.emit("notes-reminder-due", notification as unknown as JsonValue),
    onChanged: () => lifetime.emit("reminders-changed"),
  });
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const ensure = () => {
    if (!initialized) {
      store.ensure();
      reminders.load();
      initialized = true;
    }
  };
  const enqueue = <T>(context: BackendContext, operation: () => T | Promise<T>) => {
    const task = queue
      .catch(() => {})
      .then(async () => {
        context.signal.throwIfAborted();
        current = context;
        try {
          ensure();
          return await operation();
        } finally {
          current = undefined;
        }
      });
    queue = task;
    return task;
  };
  function execute(request: NotesDataRequest): unknown | Promise<unknown> {
    switch (request.action) {
      case "initialize":
        locale = request.locale ?? locale;
        return { version: 1 };
      case "note.list":
        return store
          .list()
          .filter((note) => request.category === undefined || note.category === request.category);
      case "note.get":
        return store.get(request.id);
      case "note.save":
        return store.save(request.request, request.id);
      case "note.append": {
        const note = store.get(request.id);
        return store.save(
          {
            ...note,
            content: note.content ? `${note.content}\n${request.content}` : request.content,
          },
          note.id,
        );
      }
      case "note.delete":
        return store.delete(request.id).then(() => {
          reminders.cancelForNote(request.id);
          return null;
        });
      case "note.setEditorMode":
        return store.setEditorMode(request.id, request.mode);
      case "note.move":
        return store.move(request.id, request.category);
      case "note.search": {
        const needle = request.query.toLocaleLowerCase();
        return store
          .list()
          .flatMap((meta) => {
            const note = store.get(meta.id),
              haystack = `${note.title}\n${note.content}`,
              at = haystack.toLocaleLowerCase().indexOf(needle);
            return at < 0
              ? []
              : [
                  {
                    ...meta,
                    snippet: haystack.slice(Math.max(0, at - 40), at + request.query.length + 60),
                  },
                ];
          })
          .slice(0, request.limit ?? 60);
      }
      case "note.createFromImage": {
        if (
          !["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(
            request.extension.toLowerCase(),
          )
        )
          throw new AppError("unsupportedImageFormat", "Unsupported image extension");
        const content = bytes(request.base64),
          created = store.save({
            title: request.title ?? "",
            content: "",
            category: request.category ?? "",
            editorMode: "markdown",
          });
        const relative = store.saveImage(created.id, content, request.extension);
        return store.save({ ...created, content: `![](${relative})` }, created.id);
      }
      case "category.list":
        return store.categories();
      case "category.create":
        store.createCategory(request.name);
        return null;
      case "category.rename":
        store.renameCategory(request.oldName, request.newName);
        return null;
      case "category.delete":
        store.deleteCategory(request.name);
        return null;
      case "image.save":
        return store.saveImage(request.noteId, bytes(request.base64), request.extension);
      case "image.clean":
        return store.cleanImages(request.noteId, request.content);
      case "image.resolve":
        return imagePath(
          lifetime.dataDir,
          path.isAbsolute(request.path) ? request.path : confined(lifetime.dataDir, request.path),
        );
      case "image.saveBackground": {
        const extension = request.extension.toLowerCase();
        if (!["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension))
          throw new AppError("unsupportedImageFormat", "Unsupported image extension");
        const file = confined(lifetime.dataDir, "backgrounds", `${randomUUID()}.${extension}`);
        atomicWrite(file, bytes(request.base64));
        return file;
      }
      case "storage.migrate": {
        // Prepare an opaque root copy; only the host's existing lifecycle/root
        // transaction may commit the pointer and reopen this engine there.
        const oldRoot = store.dataDir,
          oldSettings = settings.value;
        try {
          return store.migrate(request.newDir).dataDir;
        } finally {
          store.dataDir = oldRoot;
          settings.value = oldSettings;
        }
      }
      case "state.get": {
        const file = confined(lifetime.dataDir, "electron-layout.json");
        if (!fs.existsSync(file)) return null;
        if (fs.statSync(file).size > 1024 * 1024)
          throw new AppError("invalidPayload", "Layout state exceeds 1 MiB");
        return readJson(file);
      }
      case "state.put":
        atomicWrite(
          confined(lifetime.dataDir, "electron-layout.json"),
          JSON.stringify(request.value, null, 2),
        );
        return null;
      case "reminder.list":
        return request.noteId ? reminders.forNote(request.noteId) : reminders.list();
      case "reminder.set":
        return reminders.set(request.input);
      case "reminder.setPreset": {
        if (!REMINDER_PRESETS.some((preset) => preset.id === request.input.preset))
          throw new AppError("invalidPayload", "Unknown reminder preset");
        return reminders.setPreset(request.input);
      }
      case "reminder.cancel":
        reminders.cancel(request.id);
        return null;
      case "reminder.cancelForNote":
        reminders.cancelForNote(request.noteId);
        return null;
      case "reminder.tick":
        reminders.tick(request.now);
        return reminders.list();
      case "reminder.start":
        stopTimer();
        timer = setInterval(() => {
          void enqueue(lifetime, () => reminders.tick()).catch(() => {});
        }, REMINDER_TICK_MS);
        return null;
      case "reminder.stop":
        stopTimer();
        return null;
    }
  }
  return {
    async activate(activation: PluginActivation, context: BackendContext) {
      if (!activation.commandId) return;
      if (activation.commandId !== "data") {
        if (!["open", "new", "search", "open-note", "desktop-note"].includes(activation.commandId))
          throw new AppError("unknownPluginCommand", "Unknown notes command");
        return { action: activation.commandId };
      }
      if (lifetime.startupCheckOnly)
        throw new AppError(
          "pluginDisabled",
          "Startup validation does not accept notes data writes",
        );
      const request = parse(activation.parameters);
      const result = await enqueue(context, () => execute(request));
      if (
        [
          "note.save",
          "note.append",
          "note.delete",
          "note.setEditorMode",
          "note.move",
          "note.createFromImage",
          "category.create",
          "category.rename",
          "category.delete",
          "image.save",
          "image.clean",
        ].includes(request.action)
      )
        context.emit("notes-data-changed", { action: request.action });
      return result as JsonValue;
    },
    async prepareStop() {
      stopTimer();
      let settled: Promise<unknown>;
      do {
        settled = queue;
        await settled.catch(() => {});
      } while (settled !== queue);
      return { ok: true };
    },
    stop() {
      stopTimer();
      reminders.dispose();
    },
  };
}
