/* eslint-disable no-control-regex -- Windows filename controls must be rejected and sanitized. */
import fs from "node:fs";
import { HostConfigStore } from "./host-config.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_NOTE_EDITOR_MODE } from "../src/features/notes/types.js";
import type { AppConfig } from "../src/features/settings/types.js";
import type {
  Note,
  NoteMetadata,
  NoteEditorMode,
  SaveNoteRequest,
} from "../src/features/notes/types.js";

import { AppError, atomicWrite, readJson, inside, canonical, confined } from "./persistence.js";
export { AppError, atomicWrite, readJson, inside, canonical, confined } from "./persistence.js";
function component(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value === "." ||
    value.includes("..") ||
    /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)
  )
    throw new AppError("unsafePath", "文件名或分类名不合法");
  return value;
}
function request(value: SaveNoteRequest): SaveNoteRequest {
  if (
    !value ||
    typeof value.title !== "string" ||
    typeof value.content !== "string" ||
    value.content.length > 16 * 1024 * 1024
  )
    throw new AppError("invalidPayload", "便签内容不合法或超过 16 MiB");
  return {
    title: value.title,
    content: value.content,
    category: component(value.category ?? "", true),
    ...(value.editorMode !== undefined ? { editorMode: validateEditorMode(value.editorMode) } : {}),
  };
}
function validateEditorMode(value: unknown): NoteEditorMode {
  if (value !== "markdown" && value !== "text")
    throw new AppError("invalidPayload", "便签模式不合法");
  return value;
}
const preview = (text: string) =>
  Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 80).join("");
const wordCount = (text: string) => Array.from(text.replace(/\s/g, "")).length;
function fileName(id: string, title: string): string {
  const stem = Array.from(title.trim().replace(/[\s<>:"/\\|?*\x00-\x1f]+/g, "_"))
    .slice(0, 48)
    .join("")
    .replace(/^_+|_+$/g, "")
    .replace(/[. ]+$/g, "");
  return `${component(id)}${stem ? `_${stem}` : ""}.md`;
}
export { defaultConfig } from "./host-config.js";
export class NoteStore {
  dataDir: string;
  readonly hostConfig: Pick<HostConfigStore, "value" | "save">;
  get config(): AppConfig {
    return this.hostConfig.value;
  }
  constructor(
    public configDir: string,
    defaultDataDir: string,
    private recycle: (file: string) => Promise<void>,
    hostConfig?: Pick<HostConfigStore, "value" | "save">,
    options: { initialize?: boolean } = {},
  ) {
    this.hostConfig = hostConfig ?? new HostConfigStore(configDir, defaultDataDir);
    this.dataDir = this.hostConfig.value.dataDir;
    if (options.initialize !== false) this.ensure();
  }
  ensure(): void {
    fs.mkdirSync(confined(this.dataDir, "notes"), { recursive: true });
    fs.mkdirSync(this.configDir, { recursive: true });
  }
  saveConfig(config: AppConfig): AppConfig {
    return this.hostConfig.save({ ...config, dataDir: this.dataDir });
  }
  notePath(meta: Pick<NoteMetadata, "fileName" | "category">): string {
    return confined(
      this.dataDir,
      "notes",
      component(meta.category, true),
      component(meta.fileName),
    );
  }
  metadata(): NoteMetadata[] {
    const file = path.join(this.dataDir, "metadata.json");
    if (fs.existsSync(file)) {
      let parsed: { notes: NoteMetadata[] };
      try {
        parsed = readJson(file);
        if (!Array.isArray(parsed.notes)) throw new Error("invalid metadata");
      } catch {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.json`, fs.constants.COPYFILE_EXCL);
        return this.rebuild();
      }
      for (const note of parsed.notes) {
        component(note.id);
        this.notePath(note);
      }
      return parsed.notes;
    }
    return this.rebuild();
  }
  rebuild(): NoteMetadata[] {
    const notes: NoteMetadata[] = [];
    const scan = (category: string) => {
      const dir = confined(this.dataDir, "notes", category);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !category && !entry.name.startsWith(".")) {
          component(entry.name);
          scan(entry.name);
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const file = this.notePath({ category, fileName: entry.name });
        const text = fs.readFileSync(file, "utf8"),
          stat = fs.statSync(file);
        const stem = entry.name.slice(0, -3),
          index = stem.indexOf("_");
        const id = index < 0 ? stem : stem.slice(0, index);
        if (notes.some((n) => n.id === id))
          throw new AppError("duplicateNoteId", "文件中存在重复便签 ID，请先检查备份");
        const title =
          text
            .split(/\r?\n/)
            .find((line) => /^\s*# /.test(line))
            ?.trim()
            .slice(2)
            .trim() || (index < 0 ? "" : stem.slice(index + 1).replace(/_/g, " "));
        notes.push({
          id,
          title,
          fileName: entry.name,
          category,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          wordCount: wordCount(text),
          preview: preview(text),
        });
      }
    };
    scan("");
    this.commit(notes);
    return notes;
  }
  commit(notes: NoteMetadata[]): void {
    atomicWrite(path.join(this.dataDir, "metadata.json"), JSON.stringify({ notes }, null, 2));
  }
  list(): NoteMetadata[] {
    return this.metadata()
      .filter((note) => fs.existsSync(this.notePath(note)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string): Note {
    const meta = this.metadata().find((note) => note.id === id);
    if (!meta) throw new AppError("noteNotFound", `找不到便签 ${id}`, { noteId: id });
    const { preview: _, ...rest } = meta;
    return { ...rest, content: fs.readFileSync(this.notePath(meta), "utf8") };
  }
  save(value: SaveNoteRequest, id?: string): Note {
    const req = request(value),
      notes = this.metadata(),
      old = id ? notes.find((note) => note.id === id) : undefined;
    if (id && !old) throw new AppError("noteNotFound", "找不到便签", { noteId: id });
    id ??= randomUUID();
    const now = new Date().toISOString();
    const meta: NoteMetadata = {
      id,
      title: req.title,
      fileName: fileName(id, req.title),
      category: req.category,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      wordCount: wordCount(req.content),
      preview: preview(req.content),
      editorMode: req.editorMode ?? old?.editorMode ?? DEFAULT_NOTE_EDITOR_MODE,
    };
    const target = this.notePath(meta);
    const previous = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    atomicWrite(target, req.content);
    try {
      this.commit(old ? notes.map((note) => (note.id === id ? meta : note)) : [...notes, meta]);
    } catch (error) {
      // The index still owns the old note. Reuse the same atomic writer to undo
      // this body's write, without leaving a second Markdown for the same ID.
      try {
        if (previous === undefined) fs.rmSync(target, { force: true });
        else atomicWrite(target, previous);
      } catch (rollback) {
        throw new AggregateError([error, rollback], "便签索引提交及正文恢复均失败");
      }
      throw error;
    }
    if (old) {
      const source = this.notePath(old);
      // Case-only renames on Windows can refer to the same newly saved file.
      if (source.toLowerCase() !== target.toLowerCase() && fs.existsSync(source))
        fs.unlinkSync(source);
    }
    const { preview: _, ...rest } = meta;
    return { ...rest, content: req.content };
  }
  setEditorMode(id: string, mode: unknown): NoteMetadata {
    const editorMode = validateEditorMode(mode);
    const notes = this.metadata();
    const note = notes.find((item) => item.id === id);
    if (!note) throw new AppError("noteNotFound", "找不到便签", { noteId: id });
    const updated = { ...note, editorMode };
    this.commit(notes.map((item) => (item.id === id ? updated : item)));
    return updated;
  }
  async delete(id: string): Promise<void> {
    const notes = this.metadata(),
      note = notes.find((n) => n.id === id);
    if (!note) throw new AppError("noteNotFound", "找不到便签", { noteId: id });
    const target = this.notePath(note);
    if (fs.existsSync(target)) await this.recycle(target);
    this.commit(this.metadata().filter((n) => n.id !== id));
    // Keep images for recovery from the Windows Recycle Bin. Explicit unused-image cleanup is separate.
  }
  categories(): string[] {
    return fs
      .readdirSync(confined(this.dataDir, "notes"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  }
  createCategory(name: string): void {
    component(name);
    const dir = confined(this.dataDir, "notes", name);
    if (fs.existsSync(dir))
      throw new AppError("categoryAlreadyExists", `分类「${name}」已存在`, { category: name });
    fs.mkdirSync(dir);
  }
  renameCategory(oldName: string, newName: string): void {
    component(oldName);
    component(newName);
    const notes = this.metadata();
    const from = confined(this.dataDir, "notes", oldName),
      to = confined(this.dataDir, "notes", newName);
    if (!fs.existsSync(from))
      throw new AppError("categoryNotFound", "分类不存在", { category: oldName });
    if (fs.existsSync(to))
      throw new AppError("categoryAlreadyExists", "分类已存在", { category: newName });
    fs.renameSync(from, to);
    try {
      this.commit(
        notes.map((note) => (note.category === oldName ? { ...note, category: newName } : note)),
      );
    } catch (error) {
      fs.renameSync(to, from);
      throw error;
    }
  }
  deleteCategory(name: string): void {
    component(name);
    const notes = this.metadata();
    // Match the existing app: deleting a category moves its notes to uncategorized.
    const affected = notes.filter((n) => n.category === name);
    for (const meta of affected) {
      const target = this.notePath({ ...meta, category: "" });
      if (fs.existsSync(target)) throw new AppError("pathConflict", "未分类目录存在同名文件");
    }
    const moved: NoteMetadata[] = [];
    try {
      for (const meta of affected) {
        fs.renameSync(this.notePath(meta), this.notePath({ ...meta, category: "" }));
        moved.push(meta);
      }
      this.commit(notes.map((meta) => (meta.category === name ? { ...meta, category: "" } : meta)));
    } catch (error) {
      for (const meta of moved.reverse())
        fs.renameSync(this.notePath({ ...meta, category: "" }), this.notePath(meta));
      throw error;
    }
    fs.rmdirSync(confined(this.dataDir, "notes", name));
  }
  move(id: string, category: string): NoteMetadata {
    const note = this.get(id);
    this.save({ ...note, category }, id);
    return this.metadata().find((n) => n.id === id)!;
  }
  saveImage(noteId: string, bytes: Uint8Array, extension: string): string {
    this.get(noteId);
    const ext = extension.toLowerCase();
    if (
      !["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext) ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > 32 * 1024 * 1024
    )
      throw new AppError("unsupportedImageFormat", "图片格式不支持或超过 32 MiB");
    const relative = `images/${component(noteId)}/${randomUUID()}.${ext}`;
    atomicWrite(confined(this.dataDir, relative), bytes);
    return relative;
  }
  cleanImages(noteId: string, content: string): string[] {
    this.get(noteId);
    const dir = confined(this.dataDir, "images", component(noteId));
    if (!fs.existsSync(dir)) return [];
    const removed: string[] = [];
    for (const file of fs.readdirSync(dir))
      if (!content.includes(`images/${noteId}/${file}`)) {
        fs.unlinkSync(confined(dir, file));
        removed.push(file);
      }
    return removed;
  }
  planMigration(newDir: string): string {
    const dest = canonical(path.join(path.resolve(newDir), "spark233")),
      source = canonical(this.dataDir);
    if (inside(source, dest) || inside(dest, source) || dest === path.parse(dest).root)
      throw new AppError("unsafePath", "新旧目录不能互相包含");
    if (fs.existsSync(dest) && fs.readdirSync(dest).length)
      throw new AppError("pathConflict", "目标目录必须为空");
    return dest;
  }
  migrate(newDir: string, expectedRoot?: string): AppConfig {
    const dest = this.planMigration(newDir),
      source = canonical(this.dataDir);
    if (expectedRoot !== undefined && dest !== expectedRoot)
      throw new AppError("unsafePath", "迁移目的目录在授权后发生变化");
    fs.mkdirSync(dest, { recursive: true });
    // Copy then switch config; keep the source as a recovery copy, including images and layout.
    for (const item of [
      "notes",
      "images",
      "backgrounds",
      "metadata.json",
      ".spark233-preferences.json",
      "electron-layout.json",
      "reminders.json",
    ]) {
      const from = confined(source, item);
      if (fs.existsSync(from))
        fs.cpSync(from, path.join(dest, item), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
    }
    const old = this.dataDir;
    this.dataDir = dest;
    try {
      return this.saveConfig({
        ...this.config,
        dataDir: dest,
        backgroundImagePath:
          this.config.backgroundImagePath && inside(source, this.config.backgroundImagePath)
            ? path.join(dest, path.relative(source, this.config.backgroundImagePath))
            : this.config.backgroundImagePath,
      });
    } catch (error) {
      this.dataDir = old;
      throw error;
    }
  }
}
