import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Node's SQLite supplies transactions, durability and cross-window locking.
 * The existing async SDK store has no uTools revision or synchronous semantics. */
export class UToolsStore {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "utools.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, rev TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, rev TEXT NOT NULL, mime TEXT NOT NULL, body BLOB NOT NULL);",
    );
  }
  private key(value: unknown): string {
    if (typeof value !== "string" || !value || value.length > 1024) throw new Error("无效的数据键");
    return value;
  }
  private json(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("文档不是 JSON");
    if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("doc max size 1M");
    return json;
  }
  private revision(previous?: string): string {
    return `${Number(previous?.split("-")[0] || 0) + 1}-${randomUUID()}`;
  }
  get(id: unknown): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT rev,body FROM docs WHERE id=?").get(this.key(id));
    return row ? { ...JSON.parse(row.body as string), _id: id, _rev: row.rev } : null;
  }
  put(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("文档格式不合法");
    const doc = value as Record<string, unknown>,
      id = this.key(doc._id);
    const body = this.json(doc);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.get(id);
      if ((existing && existing._rev !== doc._rev) || (!existing && doc._rev))
        return { error: true, name: "conflict", message: "文档版本冲突", status: 409 };
      const rev = this.revision(existing?._rev as string | undefined);
      this.db
        .prepare(
          "INSERT INTO docs(id,rev,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,body=excluded.body",
        )
        .run(id, rev, body);
      this.db.exec("COMMIT");
      return { ok: true, id, rev };
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  remove(value: unknown): Record<string, unknown> {
    const doc = typeof value === "string" ? { _id: value } : (value as Record<string, unknown>);
    const id = this.key(doc?._id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.get(id);
      if (!existing) return { error: true, name: "not_found", status: 404 };
      if (doc._rev !== undefined && doc._rev !== existing._rev)
        return { error: true, name: "conflict", status: 409 };
      this.db.prepare("DELETE FROM docs WHERE id=?").run(id);
      this.db.prepare("DELETE FROM attachments WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return { ok: true, id, rev: this.revision(existing._rev as string) };
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  allDocs(filter?: unknown): unknown[] {
    if (Array.isArray(filter))
      return filter
        .slice(0, 10000)
        .map((id) => this.get(id))
        .filter(Boolean);
    if (filter !== undefined && typeof filter !== "string") throw new Error("无效的文档查询");
    const prefix = filter || "";
    const rows = this.db
      .prepare("SELECT id,rev,body FROM docs WHERE substr(id,1,?)=? ORDER BY id LIMIT 10001")
      .all(String(prefix).length, String(prefix));
    if (rows.length > 10000) throw new Error("文档查询超过 10000 条，请缩小前缀");
    return rows.map((row) => ({ ...JSON.parse(row.body as string), _id: row.id, _rev: row.rev }));
  }
  bulkDocs(docs: unknown): unknown[] {
    if (!Array.isArray(docs) || docs.length > 1000) throw new Error("批量文档超过限制");
    return docs.map((doc) => (doc?._deleted ? this.remove(doc) : this.put(doc)));
  }
  storage(operation: string, key?: unknown, value?: unknown): unknown {
    // uTools dbStorage and db share documents: key -> {_id:key,value}.
    if (operation === "getItem") return this.get(this.key(key))?.value ?? null;
    if (operation === "setItem") {
      const id = this.key(key),
        previous = this.get(id);
      const result = this.put({ _id: id, ...(previous ? { _rev: previous._rev } : {}), value });
      if (result.error) throw new Error("键值保存冲突");
      return;
    }
    if (operation === "removeItem") {
      this.remove(this.key(key));
      return;
    }
    if (operation === "clear") {
      this.db.exec("BEGIN IMMEDIATE; DELETE FROM docs; DELETE FROM attachments; COMMIT;");
      return;
    }
    throw new Error("不支持的存储操作");
  }
  attachment(operation: string, id: unknown, body?: unknown, mime?: unknown): unknown {
    const key = this.key(id);
    if (operation === "getAttachment") {
      const row = this.db.prepare("SELECT body FROM attachments WHERE id=?").get(key);
      return row ? Buffer.from(row.body as Uint8Array) : null;
    }
    if (operation === "getAttachmentType")
      return this.db.prepare("SELECT mime FROM attachments WHERE id=?").get(key)?.mime || null;
    if (operation === "removeAttachment")
      return {
        ok: true,
        id: key,
        removed: this.db.prepare("DELETE FROM attachments WHERE id=?").run(key).changes > 0,
      };
    if (operation === "postAttachment") {
      if (
        !(body instanceof Uint8Array) ||
        body.byteLength > 20 * 1024 * 1024 ||
        typeof mime !== "string" ||
        mime.length > 200
      )
        throw new Error("无效的附件或超过 20 MB");
      const rev = this.revision();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            "INSERT INTO attachments(id,rev,mime,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,mime=excluded.mime,body=excluded.body",
          )
          .run(key, rev, mime, body);
        this.db
          .prepare(
            "INSERT INTO docs(id,rev,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,body=excluded.body",
          )
          .run(
            key,
            rev,
            JSON.stringify({
              _id: key,
              _attachments: { data: { content_type: mime, length: body.byteLength } },
            }),
          );
        this.db.exec("COMMIT");
      } finally {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      }
      return { ok: true, id: key, rev };
    }
    throw new Error("不支持的附件操作");
  }
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
