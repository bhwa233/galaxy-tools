import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@spark233/sdk";
import type { DisplayArea } from "../shared/layer-contract.js";
import { LayerLayoutStore, desktopLayoutSchema, type NotesLayoutV2 } from "./layer-layout-store.js";
import { atomicWrite, readJson, AppError } from "./persistence.js";
import { PILL_HEIGHT } from "./capsule-layout.js";

const journalSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  phase: z.enum(["prepared", "layer-committed", "projected"]),
  sourceLayout: z.unknown(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetRevision: z.number().int().nonnegative().safe(),
});
type Journal = z.infer<typeof journalSchema>;
export interface NotesLayerOptions {
  store: LayerLayoutStore;
  journalFile: string;
  readLegacy: () => Promise<unknown>;
  writeLegacy: (layout: NotesLayoutV2) => Promise<void>;
  snapshotLegacy: () => NotesLayoutV2;
  applyLegacy: (layout: NotesLayoutV2) => void;
  switchView: (enabled: boolean) => Promise<void>;
  displays: () => readonly DisplayArea[];
  primaryDisplay: () => string;
  diagnostic: (code: string, detail: JsonValue) => void;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Reuses the store's strict compatibility schema; no note body is imported. */
export function parseNotesLayout(value: unknown): NotesLayoutV2 {
  const source =
    value === null || value === undefined ? { version: 2, windows: [], capsuleQueues: [] } : value;
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new AppError("invalidLayout", "便签布局格式无效，原数据已保留");
  const raw = source as Record<string, unknown>;
  if (raw.version !== 2 || !Array.isArray(raw.windows))
    throw new AppError("invalidLayout", "便签布局版本无效，原数据已保留");
  const parsed = desktopLayoutSchema.parse({
    version: 1,
    revision: 0,
    cards: {},
    removedInstances: [],
    notesCompat: {
      sourceVersion: 2,
      importId: randomUUID(),
      projectedRevision: 0,
      windows: raw.windows,
      capsuleQueues: raw.capsuleQueues ?? [],
    },
  }).notesCompat!;
  return { version: 2, windows: parsed.windows, capsuleQueues: parsed.capsuleQueues };
}

/** A single writer coordinates desktop layout and the notes backend projection.
 * The journal is durable before either side changes; a failed projection never
 * switches views or reads an older layout over newer desktop coordinates. */
export class NotesLayerCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private enabled = false;
  private error?: unknown;
  private retry?: ReturnType<typeof setTimeout>;
  private failures = 0;
  constructor(readonly options: NotesLayerOptions) {}
  get isEnabled(): boolean {
    return this.enabled;
  }
  get pendingError(): unknown {
    return this.error;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }
  private journal(value: Journal): void {
    atomicWrite(this.options.journalFile, JSON.stringify(value));
  }
  private projected(layout = this.options.store.load()): NotesLayoutV2 {
    if (!layout.notesCompat) throw new AppError("layer.notesMissing", "桌面便签布局尚未迁入");
    return parseNotesLayout({
      version: 2,
      windows: layout.notesCompat.windows,
      capsuleQueues: layout.notesCompat.capsuleQueues,
    });
  }
  private async commitSource(source: NotesLayoutV2, importId: string): Promise<number> {
    // Layout CAS can race an unrelated widget commit. Rebase only this notes
    // domain and never overwrite a widget's concurrently committed geometry.
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = this.options.store.load(),
        expected = next.revision;
      const removed = new Set(next.removedInstances.map((item) => item.id));
      const noteIds = new Set(
        source.windows.flatMap((entry) => (entry.noteId ? [entry.noteId] : [])),
      );
      for (const [id, card] of Object.entries(next.cards))
        if (card.kind === "notes" && !noteIds.has(card.noteId)) {
          delete next.cards[id];
          if (!removed.has(id)) next.removedInstances.push({ id, removedAt: Date.now() });
        }
      const displays = this.options.displays();
      for (const entry of source.windows) {
        if (!entry.noteId) continue;
        const id = "notes:" + entry.noteId;
        if (removed.has(id)) continue;
        const display =
          displays.find((item) => item.id === entry.capsule?.displayId) ??
          displays.find((item) => item.id === this.options.primaryDisplay()) ??
          displays[0];
        if (!display) throw new AppError("layer.displayUnavailable", "当前没有可用显示器");
        const previous = next.cards[id];
        next.cards[id] = {
          kind: "notes",
          noteId: entry.noteId,
          displayId: display.id,
          workAreaAtSave: { ...display.workArea },
          bounds:
            entry.capsule?.kind === "floating"
              ? {
                  x: entry.capsule.x,
                  y: entry.capsule.y,
                  width: previous?.bounds.width ?? 180,
                  height: PILL_HEIGHT,
                }
              : { ...entry.bounds },
          group: entry.topmost ? "top" : "normal",
          inputMode: "interactive",
          order: entry.capsule?.order ?? previous?.order ?? 0,
          visible: entry.visible,
          restore: true,
          createdAt: previous?.createdAt ?? Date.now(),
        };
      }
      next.revision++;
      next.notesCompat = {
        sourceVersion: 2,
        importId,
        projectedRevision: next.notesCompat?.projectedRevision ?? 0,
        windows: structuredClone(source.windows),
        capsuleQueues: structuredClone(source.capsuleQueues),
      };
      try {
        await this.options.store.commit(next, expected);
        return next.revision;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "layer.layoutConflict" || attempt === 2)
          throw error;
      }
    }
    throw new AppError("layer.layoutConflict", "便签布局提交发生冲突");
  }
  private async project(
    revision: number,
    source: NotesLayoutV2,
    write = this.options.writeLegacy,
  ): Promise<void> {
    const state = this.options.store.load();
    const journal: Journal = {
      version: 1,
      id: state.notesCompat!.importId,
      phase: "layer-committed",
      sourceLayout: source,
      sourceHash: hash(source),
      targetRevision: revision,
    };
    this.journal(journal);
    await write(source);
    await this.options.store.ackNotesProjection(revision);
    this.journal({ ...journal, phase: "projected" });
    fs.rmSync(this.options.journalFile, { force: true });
    clearTimeout(this.retry);
    this.retry = undefined;
    this.error = undefined;
    this.failures = 0;
  }
  private scheduleRetry(error: unknown): void {
    this.error = error;
    this.options.diagnostic("layer.notesProjectionPending", {
      message: String(error).slice(0, 512),
    });
    if (this.retry || this.failures >= 3) return;
    const delay = [1000, 3000, 10000][this.failures++];
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.serial(() => this.recoverInside()).catch((failure) => this.scheduleRetry(failure));
    }, delay);
    this.retry.unref();
  }
  private async recoverInside(write = this.options.writeLegacy): Promise<boolean> {
    if (!fs.existsSync(this.options.journalFile)) return false;
    const raw = journalSchema.parse(readJson(this.options.journalFile));
    const source = parseNotesLayout(raw.sourceLayout);
    if (hash(source) !== raw.sourceHash)
      throw new AppError("layer.notesJournalInvalid", "便签迁移记录校验失败，原文件已保留");
    const state = this.options.store.load();
    if (
      raw.phase === "prepared" &&
      (!state.notesCompat ||
        state.notesCompat.importId !== raw.id ||
        state.revision < raw.targetRevision)
    ) {
      // No desktop commit happened. The legacy source remains authoritative.
      fs.rmSync(this.options.journalFile, { force: true });
      return false;
    }
    if (!state.notesCompat || state.notesCompat.importId !== raw.id)
      throw new AppError("layer.notesJournalInvalid", "便签迁移记录与桌面布局不匹配，原文件已保留");
    const latest = this.projected(state);
    await this.project(state.revision, latest, write);
    return true;
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      await this.recoverInside();
    });
  }
  restore(raw: unknown, write = this.options.writeLegacy): Promise<NotesLayoutV2> {
    return this.serial(async () => {
      const recovered = await this.recoverInside(write);
      // raw was read before journal recovery. A successful projection just
      // superseded that copy; do not mistake it for a newer old-binary edit.
      const state = this.options.store.load();
      if (recovered) return this.projected(state);
      const legacy = parseNotesLayout(raw);
      if (!state.notesCompat) return legacy;
      const current = this.projected(state);
      if (
        !this.enabled &&
        state.notesCompat.projectedRevision === state.revision &&
        hash(legacy) !== hash(current)
      ) {
        // An older binary may have edited the projected copy. Preserve it and
        // import a new revision while the current desktop side has no changes.
        atomicWrite(this.options.journalFile + ".legacy-backup.json", JSON.stringify(legacy));
        const revision = await this.commitSource(legacy, state.notesCompat.importId);
        await this.project(revision, legacy, write);
        return legacy;
      }
      return current;
    });
  }
  persist(raw: NotesLayoutV2, write = this.options.writeLegacy): Promise<void> {
    return this.serial(async () => {
      const source = parseNotesLayout(raw),
        state = this.options.store.load();
      if (!state.notesCompat && !this.enabled) {
        await write(source);
        return;
      }
      const id = state.notesCompat?.importId ?? randomUUID();
      this.journal({
        version: 1,
        id,
        phase: "prepared",
        sourceLayout: source,
        sourceHash: hash(source),
        targetRevision: state.revision + 1,
      });
      const revision = await this.commitSource(source, id);
      try {
        await this.project(revision, source, write);
      } catch (error) {
        // The authoritative desktop commit already succeeded. Keep that view
        // and retry projection; callers must not roll their in-memory state back
        // to the previous position after a durable desktop save.
        this.scheduleRetry(error);
      }
    });
  }
  setEnabled(enabled: boolean): Promise<void> {
    return this.serial(async () => {
      await this.recoverInside();
      if (enabled === this.enabled) return;
      await this.options.store.flush();
      if (enabled) {
        const source = parseNotesLayout(this.options.snapshotLegacy());
        const persisted = parseNotesLayout(await this.options.readLegacy());
        atomicWrite(this.options.journalFile + ".legacy-backup.json", JSON.stringify(persisted));
        const state = this.options.store.load(),
          id = state.notesCompat?.importId ?? randomUUID();
        const backup = this.options.journalFile + ".source-backup.json";
        if (!fs.existsSync(backup)) atomicWrite(backup, JSON.stringify(source));
        this.journal({
          version: 1,
          id,
          phase: "prepared",
          sourceLayout: source,
          sourceHash: hash(source),
          targetRevision: state.revision + 1,
        });
        const revision = await this.commitSource(source, id);
        await this.project(revision, source);
        this.enabled = true;
        try {
          await this.options.switchView(true);
        } catch (error) {
          this.enabled = false;
          this.options.applyLegacy(this.projected());
          await this.options.switchView(false);
          throw error;
        }
      } else {
        const state = this.options.store.load(),
          source = this.projected(state);
        await this.project(state.revision, source);
        this.options.applyLegacy(source);
        await this.options.switchView(false);
        this.enabled = false;
      }
    });
  }
  async flush(): Promise<void> {
    await this.queue;
    await this.options.store.flush();
    if (this.error) throw this.error;
  }
  resetAfterRestore(): Promise<void> {
    return this.serial(async () => {
      clearTimeout(this.retry);
      this.retry = undefined;
      this.error = undefined;
      this.failures = 0;
      // The backup coordinator fences notes writes before replacing directories.
      // Revoke views only; never project the pre-restore compatibility copy into
      // the replacement backend/store during this boundary.
      await this.options.switchView(false);
      this.enabled = false;
    });
  }
  dispose(): void {
    clearTimeout(this.retry);
  }
}
