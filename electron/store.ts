/* eslint-disable no-control-regex -- Windows filename controls must be rejected and sanitized. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/features/settings/types.js";
import type { Note, NoteMetadata, SaveNoteRequest } from "../src/features/notes/types.js";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function atomicWrite(file: string, value: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
// Resolve existing ancestors too: lexical prefix checks alone permit symlink/junction escapes.
export function canonical(file: string): string {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
}
export function confined(root: string, ...parts: string[]): string {
  const file = path.resolve(root, ...parts);
  if (!inside(path.resolve(root), file) || !inside(canonical(root), canonical(file)))
    throw new AppError("unsafePath", "路径超出授权目录");
  return file;
}
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
  };
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
export function defaultConfig(dataDir: string): AppConfig {
  return {
    locale: "zh-CN",
    dataDir,
    globalShortcut: "Ctrl+Shift+N",
    closeToTray: true,
    autostart: false,
    defaultViewMode: "split",
    noteAutoSave: true,
    noteSurfaceAutoSave: true,
    tileColor: "#f6f3ec",
    tileColorMode: "system",
    theme: "system",
    fontSize: 14,
    surfaceFontSize: 14,
    tabIndentSize: 2,
    externalFileAutoSave: true,
    rememberSurfaceSize: true,
    tileCtrlClose: true,
    tileDoubleClickToEdit: false,
    tileSaveReturnsToPin: false,
    tileRenderMarkdown: false,
    renderHtmlMarkdown: false,
    splitScrollSync: true,
    toggleVisibilityShortcut: "",
    openAtCursor: true,
    backgroundImagePath: "",
    backgroundFit: "cover",
    backgroundDim: 0.25,
    backgroundBlur: 0,
    backgroundScale: 1,
    backgroundPositionX: 50,
    backgroundPositionY: 50,
  };
}
export class NoteStore {
  dataDir: string;
  config: AppConfig;
  constructor(
    public configDir: string,
    defaultDataDir: string,
    private recycle: (file: string) => Promise<void>,
  ) {
    let saved: Partial<AppConfig> & { notesDir?: string } = {};
    const configPath = path.join(configDir, "config.json");
    if (fs.existsSync(configPath)) saved = readJson(configPath); // Never silently replace a corrupt config.
    const legacy = saved.notesDir
      ? path.basename(saved.notesDir) === "notes"
        ? path.dirname(saved.notesDir)
        : saved.notesDir
      : undefined;
    this.dataDir = path.resolve(
      process.env.FLORAL_NOTEPAPER_DATA_DIR || saved.dataDir || legacy || defaultDataDir,
    );
    this.config = { ...defaultConfig(this.dataDir), ...saved, dataDir: this.dataDir };
    this.ensure();
  }
  ensure(): void {
    fs.mkdirSync(confined(this.dataDir, "notes"), { recursive: true });
    fs.mkdirSync(this.configDir, { recursive: true });
  }
  saveConfig(config: AppConfig): AppConfig {
    if (
      !config ||
      typeof config !== "object" ||
      !["system", "light", "dark"].includes(config.theme) ||
      !["system", "custom"].includes(config.tileColorMode) ||
      typeof config.globalShortcut !== "string" ||
      typeof config.toggleVisibilityShortcut !== "string" ||
      typeof config.autostart !== "boolean" ||
      typeof config.closeToTray !== "boolean"
    )
      throw new AppError("invalidPayload", "设置格式不合法");
    const value = {
      ...this.config,
      ...config,
      dataDir: this.dataDir,
      tabIndentSize: Math.max(1, Math.min(8, Number(config.tabIndentSize) || 2)),
    };
    atomicWrite(path.join(this.configDir, "config.json"), JSON.stringify(value, null, 2));
    this.config = value;
    return value;
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
    };
    const target = this.notePath(meta);
    atomicWrite(target, req.content);
    this.commit(old ? notes.map((note) => (note.id === id ? meta : note)) : [...notes, meta]);
    if (old) {
      const source = this.notePath(old);
      // Case-only renames on Windows can refer to the same newly saved file.
      if (source.toLowerCase() !== target.toLowerCase() && fs.existsSync(source))
        fs.unlinkSync(source);
    }
    const { preview: _, ...rest } = meta;
    return { ...rest, content: req.content };
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
  migrate(newDir: string): AppConfig {
    const dest = canonical(path.join(path.resolve(newDir), "floral")),
      source = canonical(this.dataDir);
    if (inside(source, dest) || inside(dest, source) || dest === path.parse(dest).root)
      throw new AppError("unsafePath", "新旧目录不能互相包含");
    if (fs.existsSync(dest) && fs.readdirSync(dest).length)
      throw new AppError("pathConflict", "目标目录必须为空");
    fs.mkdirSync(dest, { recursive: true });
    // Copy then switch config; keep the source as a recovery copy, including images and layout.
    for (const item of [
      "notes",
      "images",
      "backgrounds",
      "metadata.json",
      "electron-layout.json",
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
