import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { settingsSchema } from "../../../shared/clipboard-schema.js";
import type {
  ClipboardEntry,
  ClipboardKind,
  ClipboardPage,
  ClipboardRequest,
  ClipboardSettings,
} from "../../../src/features/clipboard/types.js";
import { atomicWrite, confined } from "../../persistence.js";

export interface RawClipboardFormat {
  id: number;
  name: string;
  bytes: Buffer;
}
export interface ClipboardSource {
  executable: string;
  title: string;
  pid?: number;
}
const MAX_BYTES = 64 * 1024 * 1024;
const registered = new Set(["HTML Format", "Rich Text Format", "PNG"]);
const builtin = new Set([13, 15, 8, 17]);
export { settingsSchema } from "../../../shared/clipboard-schema.js";
export const defaults: ClipboardSettings = {
  paused: false,
  excludedApps: [],
  excludedText: [],
  retentionDays: null,
  visibleCount: null,
  quickKeys: "digits",
  quickAction: "copy",
  compactPosition: "cursor",
};
const idSchema = z.string().min(1).max(100);
const idsSchema = z.array(idSchema).min(1).max(500);

export function decodeClipboardSnapshot(raw: Buffer): RawClipboardFormat[] {
  if (raw.length < 8 || raw.length > MAX_BYTES + 8192 || raw.readUInt32LE(0) !== 0x31424353)
    throw new Error("剪贴板快照头不合法");
  const count = raw.readUInt32LE(4);
  if (!count || count > 8) throw new Error("剪贴板格式数量超出范围");
  const formats: RawClipboardFormat[] = [];
  let offset = 8,
    total = 0;
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 12 > raw.length) throw new Error("剪贴板格式头被截断");
    const id = raw.readUInt32LE(offset),
      nameLength = raw.readUInt32LE(offset + 4),
      size = raw.readUInt32LE(offset + 8);
    offset += 12;
    total += size;
    if (nameLength > 255 || total > MAX_BYTES || offset + nameLength * 2 + size > raw.length)
      throw new Error("剪贴板格式长度不合法");
    const name = raw.toString("utf16le", offset, offset + nameLength * 2);
    offset += nameLength * 2;
    if (name ? !registered.has(name) || id < 0xc000 : !builtin.has(id))
      throw new Error("不支持此原始剪贴板格式");
    const key = name || String(id);
    if (seen.has(key)) throw new Error("快照内格式重复");
    seen.add(key);
    formats.push({ id, name, bytes: Buffer.from(raw.subarray(offset, offset + size)) });
    offset += size;
  }
  if (offset !== raw.length) throw new Error("剪贴板快照含多余内容");
  return formats;
}
export function encodeClipboardSnapshot(formats: RawClipboardFormat[]): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x31424353);
  header.writeUInt32LE(formats.length, 4);
  const parts: Buffer[] = [header];
  for (const format of formats) {
    const name = Buffer.from(format.name, "utf16le"),
      descriptor = Buffer.alloc(12);
    descriptor.writeUInt32LE(format.id);
    descriptor.writeUInt32LE(name.length / 2, 4);
    descriptor.writeUInt32LE(format.bytes.length, 8);
    parts.push(descriptor, name, format.bytes);
  }
  const result = Buffer.concat(parts);
  decodeClipboardSnapshot(result);
  return result;
}
export function textClipboardSnapshot(text: string): Buffer {
  return encodeClipboardSnapshot([
    {
      id: 13,
      name: "",
      bytes: Buffer.from(
        `${z
          .string()
          .max(32 * 1024 * 1024 - 1)
          .parse(text)}\0`,
        "utf16le",
      ),
    },
  ]);
}
function fileClipboardSnapshot(files: string[]): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20);
  header.writeUInt32LE(1, 16);
  return encodeClipboardSnapshot([
    {
      id: 15,
      name: "",
      bytes: Buffer.concat([header, Buffer.from(`${files.join("\0")}\0\0`, "utf16le")]),
    },
  ]);
}
function htmlClipboardSnapshot(text: string, fragment: string): Buffer {
  const prefix = "<html><body><!--StartFragment-->",
    suffix = "<!--EndFragment--></body></html>";
  const header = (start: number) => {
    const startFragment = start + Buffer.byteLength(prefix);
    const endFragment = startFragment + Buffer.byteLength(fragment);
    return `Version:0.9\r\nStartHTML:${String(start).padStart(10, "0")}\r\nEndHTML:${String(endFragment + Buffer.byteLength(suffix)).padStart(10, "0")}\r\nStartFragment:${String(startFragment).padStart(10, "0")}\r\nEndFragment:${String(endFragment).padStart(10, "0")}\r\n`;
  };
  const start = Buffer.byteLength(header(0));
  return encodeClipboardSnapshot([
    ...decodeClipboardSnapshot(textClipboardSnapshot(text)),
    {
      id: 0xc000,
      name: "HTML Format",
      bytes: Buffer.from(`${header(start)}${prefix}${fragment}${suffix}\0`),
    },
  ]);
}
function inspect(formats: RawClipboardFormat[]) {
  const unicode = formats.find((format) => format.id === 13 && !format.name);
  const html = formats.find((format) => format.name === "HTML Format");
  const rtf = formats.find((format) => format.name === "Rich Text Format");
  const image = formats.find(
    (format) => format.name === "PNG" || (!format.name && (format.id === 8 || format.id === 17)),
  );
  const drops = formats.find((format) => !format.name && format.id === 15);
  let files: string[] = [];
  if (drops) {
    if (drops.bytes.length < 20) throw new Error("文件引用快照头被截断");
    const offset = drops.bytes.readUInt32LE(0),
      wide = drops.bytes.readUInt32LE(16);
    if (offset < 20 || offset > drops.bytes.length || !wide || offset % 2)
      throw new Error("文件引用快照必须为 Unicode DROPFILES");
    files = drops.bytes.toString("utf16le", offset).split("\0").filter(Boolean);
    if (files.length > 4096 || files.some((file) => !path.isAbsolute(file) || file.length > 32767))
      throw new Error("文件引用路径不合法");
  }
  const text = unicode
    ? unicode.bytes.toString("utf16le").replace(/\0+$/, "")
    : html
      ? htmlFragment(html.bytes)
          .toString("utf8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\0+$/, "")
      : rtf
        ? rtf.bytes.toString("utf8").replace(/\0+$/, "")
        : files.join("\n");
  const kind: ClipboardKind = drops
    ? "files"
    : image
      ? "image"
      : html
        ? "html"
        : rtf
          ? "rtf"
          : "text";
  const names = formats.map(
    (format) =>
      format.name ||
      (
        { 13: "CF_UNICODETEXT", 15: "CF_HDROP", 8: "CF_DIB", 17: "CF_DIBV5" } as Record<
          number,
          string
        >
      )[format.id],
  );
  return { text, files, kind, names, image };
}
function htmlFragment(bytes: Buffer): Buffer {
  const header = bytes.subarray(0, 2048).toString("ascii"),
    start = Number(/StartFragment:(\d+)/i.exec(header)?.[1]),
    end = Number(/EndFragment:(\d+)/i.exec(header)?.[1]);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= bytes.length
  )
    return bytes.subarray(start, end);
  const markerStart = bytes.indexOf("<!--StartFragment-->"),
    markerEnd = bytes.indexOf("<!--EndFragment-->");
  return markerStart >= 0 && markerEnd > markerStart
    ? bytes.subarray(markerStart + 20, markerEnd)
    : bytes;
}
function imageFile(format: RawClipboardFormat): {
  content: Buffer;
  mime: string;
  extension: string;
} {
  if (format.name === "PNG") return { content: format.bytes, mime: "image/png", extension: "png" };
  const dib = format.bytes;
  if (dib.length < 40) throw new Error("图片 DIB 头不完整");
  const size = dib.readUInt32LE(0),
    depth = dib.readUInt16LE(14),
    compression = dib.readUInt32LE(16),
    used = dib.readUInt32LE(32);
  const palette = (used || (depth <= 8 ? 2 ** depth : 0)) * 4;
  const offset =
    14 +
    size +
    palette +
    (size === 40 && compression === 3 ? 12 : size === 40 && compression === 6 ? 16 : 0);
  if (size < 40 || offset > dib.length + 14) throw new Error("暂不支持此图片 DIB 文件布局");
  const header = Buffer.alloc(14);
  header.write("BM");
  header.writeUInt32LE(dib.length + 14, 2);
  header.writeUInt32LE(offset, 10);
  return { content: Buffer.concat([header, dib]), mime: "image/bmp", extension: "bmp" };
}
function contentHash(formats: RawClipboardFormat[]): string {
  const hash = createHash("sha256");
  for (const format of [...formats].sort((left, right) =>
    (left.name || String(left.id)).localeCompare(right.name || String(right.id)),
  )) {
    const identity = Buffer.from(format.name || `#${format.id}`, "utf8"),
      lengths = Buffer.alloc(8);
    lengths.writeUInt32LE(identity.length);
    lengths.writeUInt32LE(format.bytes.length, 4);
    hash.update(lengths).update(identity).update(format.bytes);
  }
  return hash.digest("hex");
}
interface EntryRow {
  id: string;
  hash: string;
  kind: ClipboardKind;
  original_text: string;
  edited_text: string | null;
  files_json: string;
  formats_json: string;
  source: string;
  source_title: string;
  created_at: number;
  last_used_at: number;
  copies: number;
  note: string;
  tags_json: string;
  pinned: number;
  sort_order: number;
  in_history: number;
  favorite: number;
  favorite_pinned: number;
  text_truncated?: number;
}
const entrySelection =
  "SELECT e.*,CASE WHEN f.entry_id IS NULL THEN 0 ELSE 1 END AS favorite,COALESCE(f.pinned,0) AS favorite_pinned FROM entries e LEFT JOIN favorites f ON f.entry_id=e.id";
const previewColumns = [
  "id",
  "hash",
  "kind",
  "original_text",
  "edited_text",
  "files_json",
  "formats_json",
  "source",
  "source_title",
  "created_at",
  "last_used_at",
  "copies",
  "note",
  "tags_json",
  "pinned",
  "sort_order",
  "in_history",
];
const previewSelection = entrySelection.replace(
  "e.*",
  previewColumns
    .map((column) =>
      ["original_text", "edited_text"].includes(column)
        ? `substr(e.${column},1,4096) AS ${column}`
        : `e.${column}`,
    )
    .join(",") + ",LENGTH(COALESCE(e.edited_text,e.original_text))>4096 AS text_truncated",
);
const galleryReference =
  "EXISTS(SELECT 1 FROM entry_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.entry_id=e.id AND g.kind='gallery')";
const draftReference = "EXISTS(SELECT 1 FROM drafts d WHERE d.entry_id=e.id)";
const draftSchema = z.strictObject({
  text: z.string().max(8 * 1024 * 1024),
  note: z.string().max(10000),
  tags: z.string().max(10000),
});
const numberValue = (value: unknown) => Number(value ?? 0);

export class ClipboardHistory {
  private database: DatabaseSync;
  private cleanup?: {
    token: string;
    ids: Array<{ id: string; fingerprint: string }>;
    expires: number;
  };
  readonly resourceDir: string;
  constructor(
    readonly directory: string,
    private options: { renderThumbnail?: (image: Uint8Array) => Uint8Array } = {},
  ) {
    fs.mkdirSync(directory, { recursive: true });
    this.resourceDir = confined(directory, "resources");
    fs.mkdirSync(this.resourceDir, { recursive: true });
    this.database = new DatabaseSync(confined(directory, "history.sqlite"));
    this.database
      .exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS resources(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE REFERENCES resources(hash),kind TEXT NOT NULL,original_text TEXT NOT NULL,edited_text TEXT,files_json TEXT NOT NULL,formats_json TEXT NOT NULL,source TEXT NOT NULL,source_title TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,copies INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',tags_json TEXT NOT NULL DEFAULT '[]',pinned INTEGER NOT NULL DEFAULT 0,sort_order REAL NOT NULL DEFAULT 0,in_history INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS entries_used ON entries(in_history,pinned,last_used_at);
      CREATE TABLE IF NOT EXISTS favorites(entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,pinned INTEGER NOT NULL DEFAULT 0,sort_order REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entry_groups(entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,PRIMARY KEY(entry_id,group_id));
      CREATE TABLE IF NOT EXISTS drafts(entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS emojis(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,name TEXT NOT NULL,group_name TEXT NOT NULL,last_used_at INTEGER NOT NULL DEFAULT 0);`);
    if (
      !this.database
        .prepare("PRAGMA table_info(emojis)")
        .all()
        .some((column) => column.name === "last_used_at")
    )
      this.database.exec("ALTER TABLE emojis ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0");
    if (!this.database.prepare("SELECT 1 FROM settings WHERE key='policy'").get())
      this.saveSettings(defaults);
    if (!this.database.prepare("SELECT 1 FROM settings WHERE key='emoji-seeded'").get()) {
      for (const symbol of [
        "😀",
        "😂",
        "🥹",
        "😍",
        "🤔",
        "😭",
        "👍",
        "👏",
        "🙏",
        "❤️",
        "🔥",
        "🎉",
        "✅",
        "❌",
        "⭐",
        "🌱",
      ])
        this.database
          .prepare("INSERT INTO emojis(id,symbol,name,group_name) VALUES(?,?,?,?)")
          .run(randomUUID(), symbol, symbol, "常用");
      this.database.prepare("INSERT INTO settings VALUES('emoji-seeded','true')").run();
    }
  }
  settings(): ClipboardSettings {
    return settingsSchema.parse(
      JSON.parse(
        String(this.database.prepare("SELECT value FROM settings WHERE key='policy'").get()?.value),
      ),
    );
  }
  saveSettings(patch: Partial<ClipboardSettings>): ClipboardSettings {
    const previous = this.database.prepare("SELECT value FROM settings WHERE key='policy'").get();
    const value = settingsSchema.parse({
      ...(previous ? JSON.parse(String(previous.value)) : defaults),
      ...patch,
    });
    this.database
      .prepare(
        "INSERT INTO settings VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value));
    return value;
  }
  capture(
    raw: Buffer,
    source: ClipboardSource,
    explicit = false,
    inHistory = true,
  ): ClipboardEntry | undefined {
    const formats = decodeClipboardSnapshot(raw),
      preview = inspect(formats),
      settings = this.settings();
    if (
      !explicit &&
      (settings.paused ||
        settings.excludedText.some((value) =>
          preview.text.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
        ))
    )
      return undefined;
    const normalizedSource = source.executable.toLocaleLowerCase();
    if (
      !explicit &&
      settings.excludedApps.some(
        (value) =>
          value.toLocaleLowerCase() === normalizedSource ||
          value.toLocaleLowerCase() === path.basename(normalizedSource),
      )
    )
      return undefined;
    const hash = contentHash(formats),
      now = Date.now();
    const existing = this.database.prepare("SELECT id FROM entries WHERE hash=?").get(hash);
    if (existing) {
      this.database
        .prepare(
          "UPDATE entries SET copies=copies+1,last_used_at=?,source=?,source_title=?,in_history=MAX(in_history,?) WHERE hash=?",
        )
        .run(now, source.executable, source.title, inHistory ? 1 : 0, hash);
      return this.entry(String(existing.id));
    }
    const filename = confined(this.resourceDir, `${hash}.scb`);
    if (!fs.existsSync(filename)) atomicWrite(filename, raw);
    const id = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("INSERT INTO resources(hash,bytes) VALUES(?,?) ON CONFLICT(hash) DO NOTHING")
        .run(hash, raw.length);
      this.database
        .prepare(
          "INSERT INTO entries(id,hash,kind,original_text,files_json,formats_json,source,source_title,created_at,last_used_at,copies,in_history) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)",
        )
        .run(
          id,
          hash,
          preview.kind,
          preview.text,
          JSON.stringify(preview.files),
          JSON.stringify(preview.names),
          source.executable,
          source.title,
          now,
          now,
          inHistory ? 1 : 0,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.entry(id);
  }
  private row(id: string): EntryRow {
    const row = this.database
      .prepare(`${entrySelection} WHERE e.id=?`)
      .get(idSchema.parse(id)) as unknown as EntryRow | undefined;
    if (!row) throw new Error("剪贴板条目不存在");
    return row;
  }
  private serialize(row: EntryRow, includeThumbnail = true, textLimit?: number): ClipboardEntry {
    const text = row.edited_text ?? row.original_text;
    return {
      thumbnailDataUrl: includeThumbnail ? this.thumbnail(row, false) : undefined,
      id: row.id,
      kind: row.kind,
      preview: text.slice(0, 240),
      text: textLimit === undefined ? text : text.slice(0, textLimit),
      textTruncated: !!row.text_truncated || (textLimit !== undefined && text.length > textLimit),
      files: JSON.parse(row.files_json),
      source: row.source,
      sourceTitle: row.source_title,
      formats: JSON.parse(row.formats_json),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      copies: row.copies,
      note: row.note,
      tags: JSON.parse(row.tags_json),
      pinned: !!row.pinned,
      favorite: !!row.favorite,
      favoritePinned: !!row.favorite_pinned,
      inHistory: !!row.in_history,
      groups: this.database
        .prepare("SELECT group_id FROM entry_groups WHERE entry_id=?")
        .all(row.id)
        .map((value) => String(value.group_id)),
    };
  }
  entry(id: string): ClipboardEntry {
    return this.serialize(this.row(id));
  }
  snapshot(id: string, mode: "original" | "text" | "image-file" = "original"): Buffer {
    const row = this.row(id);
    if (mode === "image-file") {
      return fileClipboardSnapshot([this.exportImage(id).path]);
    }
    if (mode === "text" || row.edited_text !== null)
      return textClipboardSnapshot(row.edited_text ?? row.original_text);
    const raw = fs.readFileSync(confined(this.resourceDir, `${row.hash}.scb`));
    decodeClipboardSnapshot(raw);
    const files = JSON.parse(row.files_json) as string[];
    if (files.some((filename) => !fs.existsSync(filename)))
      throw new Error("部分文件引用已失效，无法复制文件；原记录仍保留");
    return raw;
  }
  exportImage(id: string): { path: string; mimeType: string; size: number } {
    const row = this.row(id),
      formats = decodeClipboardSnapshot(
        fs.readFileSync(confined(this.resourceDir, `${row.hash}.scb`)),
      ),
      image = inspect(formats).image;
    if (!image) throw new Error("此条目不含图片");
    const normalized = confined(this.directory, `exports/${row.hash}.png`);
    if (fs.existsSync(normalized))
      return { path: normalized, mimeType: "image/png", size: fs.statSync(normalized).size };
    const exported = imageFile(image),
      filename = confined(this.directory, `exports/${row.hash}.${exported.extension}`);
    if (!fs.existsSync(filename)) atomicWrite(filename, exported.content);
    return { path: filename, mimeType: exported.mime, size: exported.content.length };
  }
  cachePng(id: string, png: Uint8Array) {
    const row = this.row(id),
      bytes = Buffer.from(png);
    if (
      bytes.length < 24 ||
      bytes.length > MAX_BYTES ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Windows 图像转换未生成受支持 PNG");
    atomicWrite(confined(this.directory, `exports/${row.hash}.png`), bytes);
    return this.exportImage(id);
  }
  hasThumbnail(id: string): boolean {
    return !!this.thumbnail(this.row(id), false);
  }
  cacheThumbnail(id: string, png: Uint8Array) {
    const row = this.row(id),
      bytes = Buffer.from(png);
    if (
      bytes.length < 24 ||
      bytes.length > 512 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Invalid clipboard PNG thumbnail");
    atomicWrite(confined(this.directory, `thumbnails/${row.hash}.png`), bytes);
  }
  copied(id: string) {
    this.row(id);
    this.database
      .prepare("UPDATE entries SET copies=copies+1,last_used_at=? WHERE id=?")
      .run(Date.now(), id);
  }
  detail(id: string) {
    const row = this.row(id),
      entry = this.serialize(row, true, 256 * 1024);
    const formats = decodeClipboardSnapshot(
        fs.readFileSync(confined(this.resourceDir, `${row.hash}.scb`)),
      ),
      data = inspect(formats);
    const html = formats.find((format) => format.name === "HTML Format"),
      rtf = formats.find((format) => format.name === "Rich Text Format");
    const htmlBytes = html ? htmlFragment(html.bytes) : undefined;
    let imageDataUrl: string | undefined = this.thumbnail(row, true);
    if (!imageDataUrl && data.image && data.image.bytes.length <= 4 * 1024 * 1024) {
      try {
        const exported = imageFile(data.image);
        imageDataUrl = `data:${exported.mime};base64,${exported.content.toString("base64")}`;
      } catch {
        /* Raw image remains recoverable when a preview is unsupported. */
      }
    }
    return {
      draft: this.draft(id),
      ...entry,
      thumbnailDataUrl: this.thumbnail(row, false),
      originalText: row.original_text.slice(0, 256 * 1024),
      textTruncated: entry.textTruncated || row.original_text.length > 256 * 1024,
      edited: row.edited_text !== null,
      imageDataUrl,
      formatPreviews: {
        html: htmlBytes
          ?.subarray(0, 256 * 1024)
          .toString("utf8")
          .replace(/\0+$/, ""),
        rtf: rtf?.bytes
          .subarray(0, 256 * 1024)
          .toString("utf8")
          .replace(/\0+$/, ""),
        truncated: (htmlBytes?.length ?? 0) > 256 * 1024 || (rtf?.bytes.length ?? 0) > 256 * 1024,
      },
      invalidFiles: entry.files.filter((filename) => !fs.existsSync(filename)),
    };
  }
  private thumbnail(row: EntryRow, create: boolean): string | undefined {
    if (row.kind !== "image") return;
    const filename = confined(this.directory, `thumbnails/${row.hash}.png`);
    try {
      if (!fs.existsSync(filename) && create && this.options.renderThumbnail) {
        const formats = decodeClipboardSnapshot(
            fs.readFileSync(confined(this.resourceDir, `${row.hash}.scb`)),
          ),
          image = inspect(formats).image;
        if (!image) return;
        const bytes = Buffer.from(
          this.options.renderThumbnail(fs.readFileSync(this.exportImage(row.id).path)),
        );
        if (
          bytes.length > 512 * 1024 ||
          bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("缩略图必须是小于 512 KiB 的 PNG");
        atomicWrite(filename, bytes);
      }
      if (fs.existsSync(filename) && fs.statSync(filename).size <= 512 * 1024)
        return `data:image/png;base64,${fs.readFileSync(filename).toString("base64")}`;
    } catch {
      /* Unsupported previews never replace the preserved raw image. */
    }
  }
  private visibleHistory(settings: ClipboardSettings) {
    // Apply retention once, before search/type/group filters. Pinned history is
    // outside both age and count limits, and does not consume ordinary slots.
    return {
      query: `WITH visible AS MATERIALIZED (
        SELECT id FROM entries WHERE in_history=1 AND pinned=1
        UNION ALL
        SELECT id FROM (SELECT id FROM entries
          WHERE in_history=1 AND pinned=0 AND last_used_at>=?
          ORDER BY sort_order,last_used_at DESC,id LIMIT ?)
      ) `,
      values: [
        settings.retentionDays ? Date.now() - settings.retentionDays * 86400000 : 0,
        settings.visibleCount ?? -1,
      ],
    };
  }
  list(request: Extract<ClipboardRequest, { action: "list" }>): ClipboardPage {
    const settings = this.settings(),
      where: string[] = [],
      values: SQLInputValue[] = [];
    const view = request.view ?? "history";
    let prefix = "";
    if (view === "history") {
      const visible = this.visibleHistory(settings);
      prefix = visible.query;
      values.push(...visible.values);
      where.push("e.id IN (SELECT id FROM visible)");
    } else if (view === "favorites") where.push("f.entry_id IS NOT NULL");
    if (request.kind) {
      where.push("e.kind=?");
      values.push(z.enum(["text", "html", "rtf", "image", "files"]).parse(request.kind));
    }
    if (request.groupId) {
      where.push("EXISTS(SELECT 1 FROM entry_groups g WHERE g.entry_id=e.id AND g.group_id=?)");
      values.push(idSchema.parse(request.groupId));
    }
    if (request.query) {
      const query = z
        .string()
        .max(1000)
        .parse(request.query)
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      where.push(
        "(e.original_text||COALESCE(e.edited_text,'')||e.note||e.tags_json||e.source||e.source_title) LIKE ? ESCAPE '\\'",
      );
      values.push(`%${query}%`);
    }
    const conditions = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const count = this.database
      .prepare(`${prefix}SELECT COUNT(*) AS count FROM (${entrySelection}${conditions})`)
      .get(...values);
    const total = numberValue(count?.count);
    const offset = z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .parse(request.offset ?? 0),
      limit = Math.min(
        z
          .number()
          .int()
          .min(1)
          .max(200)
          .parse(request.limit ?? 100),
        Math.max(0, total - offset),
      );
    const order =
      view === "favorites"
        ? "f.pinned DESC,f.sort_order,e.last_used_at DESC,e.id"
        : "e.pinned DESC,e.sort_order,e.last_used_at DESC,e.id";
    const rows = this.database
      .prepare(`${prefix}${previewSelection}${conditions} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as EntryRow[];
    let thumbnailBudget = 2 * 1024 * 1024;
    return {
      entries: rows.map((row) => {
        const entry = this.serialize(row, thumbnailBudget > 0, 4096);
        if (entry.thumbnailDataUrl) {
          thumbnailBudget -= Buffer.byteLength(entry.thumbnailDataUrl);
          if (thumbnailBudget < 0) entry.thumbnailDataUrl = undefined;
        }
        return entry;
      }),
      total,
      settings,
      groups: this.groups(),
      statistics: this.statistics(),
    };
  }
  statistics() {
    const counts = this.database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM entries) AS entries,(SELECT COUNT(*) FROM favorites) AS favorites,(SELECT COALESCE(SUM(bytes),0) FROM resources) AS bytes",
      )
      .get();
    const databaseBytes = ["history.sqlite", "history.sqlite-wal", "history.sqlite-shm"].reduce(
      (total, name) => {
        const filename = confined(this.directory, name);
        return total + (fs.existsSync(filename) ? fs.statSync(filename).size : 0);
      },
      0,
    );
    const exportDir = confined(this.directory, "exports");
    const exports = fs.existsSync(exportDir)
      ? fs
          .readdirSync(exportDir)
          .reduce((total, name) => total + fs.statSync(confined(exportDir, name)).size, 0)
      : 0;
    const thumbnailDir = confined(this.directory, "thumbnails"),
      thumbnails = fs.existsSync(thumbnailDir)
        ? fs
            .readdirSync(thumbnailDir)
            .reduce((sum, name) => sum + fs.statSync(confined(thumbnailDir, name)).size, 0)
        : 0;
    return {
      entries: numberValue(counts?.entries),
      favorites: numberValue(counts?.favorites),
      bytes: numberValue(counts?.bytes) + exports + thumbnails,
      databaseBytes,
    };
  }
  groups() {
    return this.database
      .prepare("SELECT id,name,kind FROM groups ORDER BY name,id")
      .all() as unknown as ClipboardPage["groups"];
  }
  update(request: Extract<ClipboardRequest, { action: "update" }>): ClipboardEntry {
    this.row(request.id);
    const setters: string[] = [],
      values: SQLInputValue[] = [];
    if (request.note !== undefined) {
      setters.push("note=?");
      values.push(z.string().max(10000).parse(request.note));
    }
    if (request.tags !== undefined) {
      setters.push("tags_json=?");
      values.push(
        JSON.stringify([
          ...new Set(z.array(z.string().trim().min(1).max(80)).max(64).parse(request.tags)),
        ]),
      );
    }
    if (request.editedText !== undefined) {
      setters.push("edited_text=?");
      values.push(
        z
          .string()
          .max(8 * 1024 * 1024)
          .nullable()
          .parse(request.editedText),
      );
    }
    if (request.pinned !== undefined) {
      setters.push("pinned=?");
      values.push(z.boolean().parse(request.pinned) ? 1 : 0);
    }
    if (request.order !== undefined) {
      setters.push("sort_order=?");
      values.push(z.number().finite().parse(request.order));
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (setters.length)
        this.database
          .prepare(`UPDATE entries SET ${setters.join(",")} WHERE id=?`)
          .run(...values, request.id);
      if (request.favoritePinned !== undefined || request.favoriteOrder !== undefined)
        this.database
          .prepare(
            "UPDATE favorites SET pinned=COALESCE(?,pinned),sort_order=COALESCE(?,sort_order) WHERE entry_id=?",
          )
          .run(
            request.favoritePinned === undefined
              ? null
              : z.boolean().parse(request.favoritePinned)
                ? 1
                : 0,
            request.favoriteOrder === undefined
              ? null
              : z.number().finite().parse(request.favoriteOrder),
            request.id,
          );
      if (request.groups !== undefined) {
        const groups = z.array(idSchema).max(64).parse(request.groups);
        this.database.prepare("DELETE FROM entry_groups WHERE entry_id=?").run(request.id);
        for (const group of new Set(groups))
          this.database.prepare("INSERT INTO entry_groups VALUES(?,?)").run(request.id, group);
        if (
          groups.some((group) =>
            this.database.prepare("SELECT 1 FROM groups WHERE id=? AND kind='favorite'").get(group),
          )
        )
          this.database
            .prepare("INSERT INTO favorites(entry_id) VALUES(?) ON CONFLICT(entry_id) DO NOTHING")
            .run(request.id);
      }
      if (
        request.editedText !== undefined ||
        request.note !== undefined ||
        request.tags !== undefined
      )
        this.database.prepare("DELETE FROM drafts WHERE entry_id=?").run(request.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.entry(request.id);
  }
  private draft(id: string) {
    const row = this.database
      .prepare("SELECT payload FROM drafts WHERE entry_id=?")
      .get(idSchema.parse(id));
    return row ? draftSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }
  saveDraft(request: Extract<ClipboardRequest, { action: "draft.save" }>) {
    this.row(request.id);
    const draft = draftSchema.parse({ text: request.text, note: request.note, tags: request.tags });
    this.database
      .prepare(
        "INSERT INTO drafts VALUES(?,?) ON CONFLICT(entry_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(request.id, JSON.stringify(draft));
    return { saved: true };
  }
  removeDraft(id: string) {
    this.database.prepare("DELETE FROM drafts WHERE entry_id=?").run(idSchema.parse(id));
    return { removed: true };
  }
  favorite(id: string, enabled: boolean) {
    this.row(id);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (enabled)
        this.database
          .prepare("INSERT INTO favorites(entry_id) VALUES(?) ON CONFLICT(entry_id) DO NOTHING")
          .run(id);
      else {
        this.database
          .prepare(
            "DELETE FROM entry_groups WHERE entry_id=? AND group_id IN (SELECT id FROM groups WHERE kind='favorite')",
          )
          .run(id);
        this.database.prepare("DELETE FROM favorites WHERE entry_id=?").run(id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.entry(id);
  }
  removeHistory(ids: string[]) {
    for (const id of idsSchema.parse(ids))
      this.database.prepare("UPDATE entries SET in_history=0 WHERE id=?").run(id);
    return { removed: ids.length, retainedForReview: true };
  }
  group(request: Extract<ClipboardRequest, { action: "groups" }>) {
    if (request.deleteId)
      this.database.prepare("DELETE FROM groups WHERE id=?").run(idSchema.parse(request.deleteId));
    else if (request.name)
      this.database
        .prepare("INSERT INTO groups VALUES(?,?,?)")
        .run(
          randomUUID(),
          z.string().trim().min(1).max(80).parse(request.name),
          z.enum(["gallery", "favorite"]).parse(request.kind ?? "gallery"),
        );
    return this.groups();
  }
  importImage(png: Uint8Array, name: string, groupId?: string): ClipboardEntry {
    const bytes = Buffer.from(png);
    if (
      bytes.length < 24 ||
      bytes.length > 32 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("图库导入只接受宿主解码后的 PNG，最大 32 MiB");
    let group = groupId
      ? this.database.prepare("SELECT id,kind FROM groups WHERE id=?").get(idSchema.parse(groupId))
      : undefined;
    if (group && group.kind !== "gallery") throw new Error("图片必须导入到图库分组");
    if (groupId && !group) throw new Error("图库分组不存在");
    if (!group) {
      group = this.database
        .prepare("SELECT id,kind FROM groups WHERE kind='gallery' ORDER BY name,id LIMIT 1")
        .get();
      if (!group) {
        const id = randomUUID();
        this.database.prepare("INSERT INTO groups VALUES(?,?,'gallery')").run(id, "导入图片");
        group = { id, kind: "gallery" };
      }
    }
    const raw = encodeClipboardSnapshot([{ id: 0xc000, name: "PNG", bytes }]);
    const entry = this.capture(
      raw,
      { executable: "spark233.gallery", title: z.string().max(512).parse(name) },
      true,
      false,
    )!;
    this.database
      .prepare("INSERT INTO entry_groups VALUES(?,?) ON CONFLICT DO NOTHING")
      .run(entry.id, String(group.id));
    return this.entry(entry.id);
  }
  merge(request: Extract<ClipboardRequest, { action: "merge" }>) {
    const entries = idsSchema.parse(request.ids).map((id) => this.entry(id));
    let raw: Buffer;
    if (request.kind === "files") {
      if (entries.some((entry) => entry.kind !== "files"))
        throw new Error("文件合并只接受文件条目");
      const files = [...new Set(entries.flatMap((entry) => entry.files))];
      if (files.some((filename) => !fs.existsSync(filename)))
        throw new Error("合并前请处理失效的文件引用");
      raw = fileClipboardSnapshot(files);
    } else if (request.kind === "rich") {
      if (
        entries.some((entry) => entry.kind === "files" || (!entry.text && entry.kind !== "image"))
      )
        throw new Error("图文合并只接受文字或图片条目");
      const fragments = entries.map((entry) => {
        if (entry.kind === "image") {
          const row = this.row(entry.id),
            formats = decodeClipboardSnapshot(
              fs.readFileSync(confined(this.resourceDir, `${row.hash}.scb`)),
            );
          const image = inspect(formats).image;
          if (!image) throw new Error("图片原始资源不存在");
          const file = imageFile(image);
          return `<p><img src="data:${file.mime};base64,${file.content.toString("base64")}" alt=""></p>`;
        }
        return `<p>${entry.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`;
      });
      raw = htmlClipboardSnapshot(
        entries.map((entry) => (entry.kind === "image" ? "[图片]" : entry.text)).join("\n"),
        fragments.join("\n"),
      );
    } else if (request.kind === "text") {
      if (entries.some((entry) => !entry.text || entry.kind === "files" || entry.kind === "image"))
        throw new Error("文字合并只接受具有文字的条目");
      raw = textClipboardSnapshot(
        entries
          .map((entry) => entry.text)
          .join(
            z
              .string()
              .max(1000)
              .parse(request.separator ?? "\n"),
          ),
      );
    } else throw new Error("不支持此合并格式");
    // Explicit user-created content is allowed while passive recording is paused.
    return this.capture(raw, { executable: "spark233", title: "合并条目" }, true)!;
  }
  previewCleanup(request: Extract<ClipboardRequest, { action: "cleanup.preview" }>) {
    let rows = this.database
      .prepare(
        `${previewSelection} WHERE e.pinned=0 AND f.entry_id IS NULL AND NOT ${galleryReference} AND NOT ${draftReference} AND e.in_history=0 LIMIT 501`,
      )
      .all() as unknown as EntryRow[];
    if (request.ids)
      rows = idsSchema
        .parse(request.ids)
        .map(
          (id) =>
            this.database
              .prepare(`${previewSelection} WHERE e.id=?`)
              .get(id) as unknown as EntryRow,
        )
        .filter(Boolean)
        .filter(
          (row) =>
            !row.pinned &&
            !row.favorite &&
            !this.draft(row.id) &&
            !this.database
              .prepare(
                "SELECT 1 FROM entry_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.entry_id=? AND g.kind='gallery'",
              )
              .get(row.id),
        );
    else if (request.outsideVisibleRange) {
      const visible = this.visibleHistory(this.settings());
      rows = this.database
        .prepare(
          `${visible.query}${previewSelection} WHERE e.pinned=0 AND f.entry_id IS NULL AND NOT ${galleryReference} AND NOT ${draftReference} AND NOT EXISTS(SELECT 1 FROM visible WHERE visible.id=e.id) LIMIT 501`,
        )
        .all(...visible.values) as unknown as EntryRow[];
    }
    const hasMore = rows.length > 500;
    rows = rows.slice(0, 500);
    this.cleanup = {
      token: randomUUID(),
      ids: rows.map((row) => ({ id: row.id, fingerprint: this.fingerprint(row) })),
      expires: Date.now() + 10 * 60000,
    };
    const entries = rows.map((row) => this.serialize(row, false, 4096));
    const bytes = rows.reduce(
      (total, row) =>
        total +
        numberValue(
          this.database.prepare("SELECT bytes FROM resources WHERE hash=?").get(row.hash)?.bytes,
        ),
      0,
    );
    return { token: this.cleanup.token, entries, count: rows.length, bytes, hasMore };
  }
  confirmCleanup(token: string) {
    const preview = this.cleanup;
    if (!preview || preview.token !== token || preview.expires < Date.now())
      throw new Error("待清理预览已失效，请重新查看");
    this.cleanup = undefined;
    let removed = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of preview.ids) {
        let current: EntryRow;
        try {
          current = this.row(entry.id);
        } catch {
          continue;
        }
        if (this.fingerprint(current) !== entry.fingerprint) continue;
        removed += numberValue(
          this.database
            .prepare(
              "DELETE FROM entries WHERE id=? AND pinned=0 AND NOT EXISTS(SELECT 1 FROM drafts WHERE entry_id=entries.id) AND NOT EXISTS(SELECT 1 FROM favorites WHERE entry_id=entries.id) AND NOT EXISTS(SELECT 1 FROM entry_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.entry_id=entries.id AND g.kind='gallery')",
            )
            .run(entry.id).changes,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const unused = this.database
      .prepare(
        "SELECT hash FROM resources WHERE NOT EXISTS(SELECT 1 FROM entries WHERE entries.hash=resources.hash)",
      )
      .all();
    for (const item of unused) {
      const hash = String(item.hash);
      fs.rmSync(confined(this.resourceDir, `${hash}.scb`), { force: true });
      this.database.prepare("DELETE FROM resources WHERE hash=?").run(hash);
    }
    for (const name of fs.readdirSync(this.resourceDir)) {
      if (
        /^[a-f0-9]{64}\.scb$/.test(name) &&
        !this.database.prepare("SELECT 1 FROM resources WHERE hash=?").get(name.slice(0, 64))
      )
        fs.rmSync(confined(this.resourceDir, name), { force: true });
    }
    const thumbnailDir = confined(this.directory, "thumbnails");
    if (fs.existsSync(thumbnailDir))
      for (const name of fs.readdirSync(thumbnailDir)) {
        if (
          /^[a-f0-9]{64}\.png$/.test(name) &&
          !this.database.prepare("SELECT 1 FROM resources WHERE hash=?").get(name.slice(0, 64))
        )
          fs.rmSync(confined(thumbnailDir, name), { force: true });
      }
    const exportDir = confined(this.directory, "exports");
    if (fs.existsSync(exportDir)) {
      const references = new Set(
        this.database
          .prepare("SELECT files_json FROM entries")
          .all()
          .flatMap((row) => JSON.parse(String(row.files_json)) as string[]),
      );
      for (const name of fs.readdirSync(exportDir)) {
        const hash = name.split(".")[0],
          filename = confined(exportDir, name);
        if (
          /^[a-f0-9]{64}\.(?:png|bmp)$/.test(name) &&
          !references.has(filename) &&
          !this.database.prepare("SELECT 1 FROM resources WHERE hash=?").get(hash)
        )
          fs.rmSync(filename, { force: true });
      }
    }
    return { removed, resourcesReclaimed: unused.length, statistics: this.statistics() };
  }
  private fingerprint(row: EntryRow): string {
    // Preview is an explicit user decision. Include edits, counts and group
    // references so same-millisecond copies or edits cannot be deleted later.
    const groups = this.database
      .prepare("SELECT group_id FROM entry_groups WHERE entry_id=? ORDER BY group_id")
      .all(row.id);
    return createHash("sha256")
      .update(JSON.stringify({ row: this.row(row.id), groups, draft: this.draft(row.id) }))
      .digest("hex");
  }
  emojis() {
    return this.database
      .prepare(
        "SELECT id,symbol,name,group_name AS 'group',last_used_at AS lastUsedAt FROM emojis ORDER BY last_used_at DESC,group_name,rowid",
      )
      .all();
  }
  addEmoji(symbol: string, name = symbol, group = "自定义") {
    const id = randomUUID();
    this.database
      .prepare("INSERT INTO emojis(id,symbol,name,group_name) VALUES(?,?,?,?)")
      .run(
        id,
        z.string().min(1).max(80).parse(symbol),
        z.string().max(80).parse(name),
        z.string().min(1).max(80).parse(group),
      );
    return this.emojis();
  }
  removeEmoji(id: string) {
    this.database.prepare("DELETE FROM emojis WHERE id=?").run(idSchema.parse(id));
    return this.emojis();
  }
  emojiSnapshot(id: string) {
    const emoji = this.database
      .prepare("SELECT symbol FROM emojis WHERE id=?")
      .get(idSchema.parse(id));
    if (!emoji) throw new Error("表情符号不存在");
    return textClipboardSnapshot(String(emoji.symbol));
  }
  usedEmoji(id: string) {
    this.database
      .prepare("UPDATE emojis SET last_used_at=? WHERE id=?")
      .run(Date.now(), idSchema.parse(id));
  }
  checkpoint() {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    this.checkpoint();
    this.database.close();
  }
}
