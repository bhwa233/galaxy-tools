import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Rect, CapsuleQueue } from "../src/features/capsules/types.js";
import type { NoteLayoutState } from "./note-window-state.js";
import { intersectRect } from "./capsule-layout.js";
import { AppError, atomicWrite, readJson } from "./persistence.js";

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const size = z.number().finite().positive().max(32768);
const rectSchema = z.strictObject({ x: coordinate, y: coordinate, width: size, height: size });
const identifier = z.string().min(1).max(160);
const localId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const common = {
  displayId: identifier,
  workAreaAtSave: rectSchema,
  bounds: rectSchema,
  group: z.enum(["normal", "top"]),
  inputMode: z.enum(["passive", "interactive"]),
  order: z.number().int().safe(),
  visible: z.boolean(),
  restore: z.boolean(),
  createdAt: z.number().int().nonnegative().safe(),
};
const widgetCardSchema = z.strictObject({
  ...common,
  kind: z.literal("widget"),
  pluginId: localId,
  widgetDefinitionId: localId,
  widgetInstanceId: z.uuid(),
  edgeAutoHide: z.boolean().optional(),
  fullscreenAutoHide: z.boolean().optional(),
});
const noteCardSchema = z.strictObject({ ...common, kind: z.literal("notes"), noteId: identifier });
const screenshotCardSchema = z.strictObject({
  ...common,
  kind: z.literal("screenshot"),
  screenshotId: z.uuid(),
});
const utoolsCardSchema = z.strictObject({
  ...common,
  kind: z.literal("utools"),
  pluginId: localId,
  utoolsInstanceId: z.uuid(),
  featureCode: z.string().min(1).max(160),
});
const storedCardSchema = z.discriminatedUnion("kind", [
  widgetCardSchema,
  noteCardSchema,
  screenshotCardSchema,
  utoolsCardSchema,
]);
const placementSchema = z.strictObject({
  kind: z.enum(["docked", "floating"]),
  displayId: identifier,
  edge: z.enum(["left", "right", "top"]),
  order: z.number().int().safe(),
  x: coordinate,
  y: coordinate,
});
const notesCompatSchema = z.strictObject({
  sourceVersion: z.literal(2),
  importId: z.uuid(),
  projectedRevision: z.number().int().nonnegative().safe(),
  windows: z
    .array(
      z.strictObject({
        label: identifier,
        noteId: identifier.optional(),
        view: z.enum(["main", "launcher", "notepad", "tile"]),
        bounds: rectSchema,
        visible: z.boolean(),
        folded: z.boolean().optional(),
        topmost: z.boolean(),
        everOpened: z.boolean().optional(),
        capsule: placementSchema.optional(),
        windowProfile: identifier.optional(),
        workspace: z
          .enum(["clipboard", "translation", "ocr", "screenshot-history", "search"])
          .optional(),
        compact: z.boolean().optional(),
        pluginId: localId.optional(),
      }),
    )
    .max(512),
  capsuleQueues: z
    .array(
      z.strictObject({
        key: identifier,
        offset: coordinate,
        collapsed: z.boolean(),
        scroll: z.number().finite().nonnegative(),
        centered: z.boolean().optional(),
      }),
    )
    .max(128),
});

export const desktopLayoutSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    cards: z.record(identifier, storedCardSchema),
    notesCompat: notesCompatSchema.optional(),
    removedInstances: z
      .array(
        z.strictObject({
          id: identifier,
          removedAt: z.number().int().nonnegative().safe(),
        }),
      )
      .max(512),
  })
  .superRefine((state, context) => {
    if (Object.keys(state.cards).length > 512)
      context.addIssue({ code: "custom", message: "Desktop layout exceeds 512 stored cards" });
    const removed = new Set(state.removedInstances.map((entry) => entry.id));
    const compatibilityPlugins = new Set<string>();
    if (removed.size !== state.removedInstances.length)
      context.addIssue({
        code: "custom",
        message: "Desktop layout has duplicate removed instances",
      });
    for (const [id, card] of Object.entries(state.cards)) {
      if (card.kind === "utools") {
        if (compatibilityPlugins.has(card.pluginId))
          context.addIssue({
            code: "custom",
            path: ["cards", id],
            message: "A compatibility plugin has more than one desktop window",
          });
        compatibilityPlugins.add(card.pluginId);
      }
      const expected =
        card.kind === "widget"
          ? `widget:${card.widgetInstanceId}`
          : card.kind === "screenshot"
            ? `screenshot:${card.screenshotId}`
            : card.kind === "utools"
              ? `utools:${card.utoolsInstanceId}`
              : `notes:${card.noteId}`;
      if (id !== expected || removed.has(id))
        context.addIssue({
          code: "custom",
          path: ["cards", id],
          message: "Card identity conflicts with stored instance",
        });
    }
    if (state.notesCompat && state.notesCompat.projectedRevision > state.revision)
      context.addIssue({ code: "custom", message: "Notes projection is newer than the layout" });
  });

export type WidgetLayoutCard = z.infer<typeof widgetCardSchema>;
export type NotesLayoutCard = z.infer<typeof noteCardSchema>;
export type ScreenshotLayoutCard = z.infer<typeof screenshotCardSchema>;
export type UToolsLayoutCard = z.infer<typeof utoolsCardSchema>;
export type StoredLayerCard =
  | WidgetLayoutCard
  | NotesLayoutCard
  | ScreenshotLayoutCard
  | UToolsLayoutCard;
export type DesktopLayoutV1 = z.infer<typeof desktopLayoutSchema>;
export interface NotesLayoutV2 {
  version: 2;
  windows: Array<NoteLayoutState & { label: string; noteId?: string }>;
  capsuleQueues: CapsuleQueue[];
}
export interface LayerLayoutEdit {
  id: string;
  ownerId: string;
  revision: number;
  layout: DesktopLayoutV1;
}
const patchSchema = z.strictObject({
  displayId: identifier.optional(),
  workAreaAtSave: rectSchema.optional(),
  bounds: rectSchema.optional(),
  group: z.enum(["normal", "top"]).optional(),
  order: z.number().int().safe().optional(),
  visible: z.boolean().optional(),
});
export interface LayerLayoutMutation {
  cardId: string;
  patch: Partial<
    Pick<StoredLayerCard, "displayId" | "workAreaAtSave" | "bounds" | "group" | "order" | "visible">
  >;
}
interface StoreOptions {
  file: string;
  now?: () => number;
  atomicWrite?: typeof atomicWrite;
  readJson?: (file: string) => unknown;
  onError?: (error: unknown) => void;
}
const emptyLayout = (): DesktopLayoutV1 => ({
  version: 1,
  revision: 0,
  cards: {},
  removedInstances: [],
});
const MAX_BYTES = 1024 * 1024;

/** Existing atomicWrite supplies fsync/rename; no other component writes layout.
 * Invalid/future files remain intact. Runtime owners and business data never enter this file. */
export class LayerLayoutStore {
  private readFailure?: unknown;
  private state = emptyLayout();
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private reloading = false;
  private listeners = new Set<(state: DesktopLayoutV1) => void>();
  private scheduled?: DesktopLayoutV1;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private pendingError?: unknown;
  private edit?: LayerLayoutEdit;
  private closed = false;

  constructor(private readonly options: StoreOptions) {
    this.readDisk();
  }
  get readError(): unknown {
    return this.readFailure;
  }
  private readDisk(): void {
    this.state = emptyLayout();
    this.readFailure = undefined;
    try {
      if (fs.existsSync(this.options.file)) {
        if (fs.statSync(this.options.file).size > MAX_BYTES)
          throw new Error("Desktop layout exceeds 1 MiB");
        this.state = desktopLayoutSchema.parse(
          (this.options.readJson ?? readJson)(this.options.file),
        );
      }
    } catch (error) {
      this.readFailure = error;
    }
  }

  load(): DesktopLayoutV1 {
    return structuredClone(this.state);
  }
  subscribe(listener: (state: DesktopLayoutV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private enqueue<T>(operation: () => T | Promise<T>, restoring = false): Promise<T> {
    if (this.reloading && !restoring)
      return Promise.reject(new AppError("maintenance", "桌面布局正在恢复"));
    const generation = this.generation;
    const result = this.queue.then(() => {
      if (generation !== this.generation)
        throw new AppError("layer.layoutConflict", "桌面布局已从备份恢复，请重新读取后再试");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private requireWritable(): void {
    if (this.closed) throw new AppError("layer.disposed", "桌面布局存储已关闭");
    if (this.reloading) throw new AppError("maintenance", "桌面布局正在恢复");
    if (this.readError)
      throw new AppError("layer.layoutUnreadable", "桌面布局无法读取，原文件已保留");
  }
  private write(next: DesktopLayoutV1): void {
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_BYTES)
      throw new AppError("layer.layoutFull", "桌面布局存储已满，未删除已有卡片");
    (this.options.atomicWrite ?? atomicWrite)(this.options.file, encoded);
    this.state = next;
    this.pendingError = undefined;
  }
  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.load());
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
  commit(next: DesktopLayoutV1, expectedRevision: number): Promise<void> {
    const candidate = desktopLayoutSchema.parse(structuredClone(next));
    return this.enqueue(() => {
      this.requireWritable();
      if (this.state.revision !== expectedRevision || candidate.revision !== expectedRevision + 1)
        throw new AppError("layer.layoutConflict", "桌面布局已改变，请重新读取后再试");
      // A user commit supersedes an uncommitted geometry observation of that revision.
      if (this.scheduled?.revision === candidate.revision) this.clearSchedule();
      this.write(candidate);
      this.publish();
    });
  }
  ackNotesProjection(revision: number): Promise<void> {
    return this.enqueue(() => {
      this.requireWritable();
      const compat = this.state.notesCompat;
      if (!compat || revision <= compat.projectedRevision) return;
      if (!Number.isSafeInteger(revision) || revision > this.state.revision)
        throw new AppError("layer.layoutConflict", "便签投影版本无效");
      this.write({
        ...this.load(),
        notesCompat: { ...structuredClone(compat), projectedRevision: revision },
      });
      // Projection acknowledgement is metadata, never a new layout revision/event.
    });
  }
  schedule(next: DesktopLayoutV1): void {
    this.requireWritable();
    const candidate = desktopLayoutSchema.parse(structuredClone(next));
    if (candidate.revision !== this.state.revision + 1)
      throw new AppError("layer.layoutConflict", "系统布局基线已改变");
    this.scheduled = candidate;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    const generation = this.generation;
    const drain = () => {
      void this.drainScheduled().catch((error) => {
        if (generation !== this.generation) return;
        this.pendingError = error;
        this.options.onError?.(error);
      });
    };
    this.settleTimer = setTimeout(drain, 250);
    this.maxTimer ??= setTimeout(drain, 1000);
  }
  private clearSchedule(): DesktopLayoutV1 | undefined {
    const next = this.scheduled;
    this.scheduled = undefined;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.settleTimer = this.maxTimer = undefined;
    return next;
  }
  private drainScheduled(): Promise<void> {
    const next = this.clearSchedule();
    if (!next) return Promise.resolve();
    return this.enqueue(() => {
      this.requireWritable();
      // Do not replace a user edit with stale system geometry; the next screen
      // reconciliation starts from load() and can calculate a fresh observation.
      if (this.state.revision !== next.revision - 1) return;
      this.write(next);
      this.publish();
    });
  }
  async flush(): Promise<void> {
    await this.drainScheduled();
    await this.queue;
    if (this.pendingError) throw this.pendingError;
  }
  /** The backup coordinator has already flushed and fenced UI/plugin writes.
   * A restored directory replaces the write baseline; never drain old geometry
   * into it, including writes that were queued just before this boundary. */
  reloadAfterRestore(): Promise<void> {
    if (this.closed) return Promise.reject(new AppError("layer.disposed", "桌面布局存储已关闭"));
    if (this.reloading) return Promise.reject(new AppError("maintenance", "桌面布局正在恢复"));
    this.reloading = true;
    this.generation++;
    this.clearSchedule();
    this.edit = undefined;
    this.pendingError = undefined;
    return this.enqueue(() => {
      this.readDisk();
      this.reloading = false;
      this.publish();
    }, true).finally(() => {
      this.reloading = false;
    });
  }
  async dispose(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.edit = undefined;
    this.listeners.clear();
  }
  beginEdit(ownerId: string): LayerLayoutEdit {
    this.requireWritable();
    if (this.edit) throw new AppError("layer.editBusy", "已有桌面布局编辑会话");
    this.edit = { id: randomUUID(), ownerId, revision: this.state.revision, layout: this.load() };
    return structuredClone(this.edit);
  }
  previewEdit(id: string, mutations: readonly LayerLayoutMutation[]): LayerLayoutEdit {
    const edit = this.requireEdit(id);
    if (!mutations.length || mutations.length > 64)
      throw new AppError("layer.card.invalid", "桌面布局编辑数量无效");
    const layout = structuredClone(edit.layout);
    for (const mutation of mutations) {
      const card = layout.cards[mutation.cardId];
      if (!card) throw new AppError("layer.card.invalid", "桌面卡片已不存在");
      layout.cards[mutation.cardId] = { ...card, ...patchSchema.parse(mutation.patch) };
    }
    edit.layout = desktopLayoutSchema.parse(layout);
    return structuredClone(edit);
  }
  async endEdit(id: string, apply: boolean): Promise<DesktopLayoutV1> {
    if (!apply) {
      this.requireWritable();
      if (!this.edit || this.edit.id !== id)
        throw new AppError("layer.editExpired", "桌面布局编辑会话已失效");
      this.edit = undefined;
      return this.load();
    }
    const edit = this.requireEdit(id);
    await this.commit({ ...edit.layout, revision: edit.revision + 1 }, edit.revision);
    if (this.edit?.id === id) this.edit = undefined;
    return this.load();
  }
  private requireEdit(id: string): LayerLayoutEdit {
    this.requireWritable();
    if (!this.edit || this.edit.id !== id)
      throw new AppError("layer.editExpired", "桌面布局编辑会话已失效");
    if (this.edit.revision !== this.state.revision)
      throw new AppError("layer.layoutConflict", "编辑期间桌面布局已改变");
    return this.edit;
  }
  async mergeDefaults(defaults: Readonly<Record<string, StoredLayerCard>>): Promise<void> {
    const next = this.load(),
      removed = new Set(next.removedInstances.map((entry) => entry.id));
    let changed = false;
    for (const [id, card] of Object.entries(defaults))
      if (!Object.hasOwn(next.cards, id) && !removed.has(id)) {
        next.cards[id] = structuredClone(card);
        changed = true;
      }
    if (changed) await this.commit({ ...next, revision: next.revision + 1 }, next.revision);
  }
  removeWidget(widgetInstanceId: string): Promise<void> {
    return this.removeCard(`widget:${z.uuid().parse(widgetInstanceId)}`);
  }
  removeScreenshot(screenshotId: string): Promise<void> {
    return this.removeCard(`screenshot:${z.uuid().parse(screenshotId)}`);
  }
  removeUTools(instanceId: string): Promise<void> {
    return this.removeCard(`utools:${z.uuid().parse(instanceId)}`);
  }
  private async removeCard(id: string): Promise<void> {
    const next = this.load();
    if (!Object.hasOwn(next.cards, id)) return;
    if (next.removedInstances.length >= 512)
      throw new AppError("layer.layoutFull", "已移除卡片记录已满，未删除已有数据");
    delete next.cards[id];
    next.removedInstances.push({ id, removedAt: (this.options.now ?? Date.now)() });
    await this.commit({ ...next, revision: next.revision + 1 }, next.revision);
  }
}

export interface LayerDisplayArea {
  id: string;
  workArea: Rect;
}
export function constrainLayerCard<T extends StoredLayerCard>(
  original: T,
  displays: readonly LayerDisplayArea[],
  primaryId?: string,
  limits?: { min?: { width: number; height: number }; max?: { width: number; height: number } },
): { card: T; constrained: boolean } {
  const display =
    displays.find((item) => item.id === original.displayId) ??
    displays.find((item) => item.id === primaryId) ??
    displays[0];
  if (!display) throw new AppError("layer.displayUnavailable", "当前没有可用显示器");
  const area = rectSchema.parse(display.workArea),
    old = original.workAreaAtSave;
  const sameDisplay = display.id === original.displayId;
  const compatibility = original.kind === "utools";
  const topInset = compatibility ? Math.min(40, Math.max(0, area.height - 1)) : 0;
  const width = Math.min(
    area.width,
    Math.max(
      limits?.min?.width ?? (compatibility ? 320 : 1),
      Math.min(original.bounds.width, limits?.max?.width ?? 32768),
    ),
  );
  const height = Math.min(
    area.height - topInset,
    Math.max(
      limits?.min?.height ?? (compatibility ? 160 : 1),
      Math.min(original.bounds.height, limits?.max?.height ?? 32768),
    ),
  );
  const proposedX =
    area.x + (original.bounds.x - old.x) * (sameDisplay ? 1 : area.width / old.width);
  const proposedY =
    area.y + (original.bounds.y - old.y) * (sameDisplay ? 1 : area.height / old.height);
  const bounds = {
    x: Math.max(area.x, Math.min(area.x + area.width - width, proposedX)),
    y: Math.max(area.y + topInset, Math.min(area.y + area.height - height, proposedY)),
    width,
    height,
  };
  const card = {
    ...structuredClone(original),
    displayId: display.id,
    workAreaAtSave: { ...area },
    bounds,
  };
  return { card, constrained: JSON.stringify(card) !== JSON.stringify(original) };
}

/** Search occupied edges instead of every pixel; active-card quota bounds work. */
export function findLayerPlacement(
  bounds: Rect,
  area: Rect,
  occupied: readonly Rect[],
): Rect | undefined {
  if (bounds.width > area.width || bounds.height > area.height) return undefined;
  const clampX = (x: number) => Math.max(area.x, Math.min(area.x + area.width - bounds.width, x));
  const clampY = (y: number) => Math.max(area.y, Math.min(area.y + area.height - bounds.height, y));
  const xs = [
    ...new Set(
      [bounds.x, area.x + 8, ...occupied.map((rect) => rect.x + rect.width + 8)].map(clampX),
    ),
  ];
  const ys = [
    ...new Set(
      [bounds.y, area.y + 8, ...occupied.map((rect) => rect.y + rect.height + 8)].map(clampY),
    ),
  ];
  return xs
    .flatMap((x) => ys.map((y) => ({ ...bounds, x, y })))
    .sort(
      (a, b) =>
        Math.abs(a.x - bounds.x) +
          Math.abs(a.y - bounds.y) -
          (Math.abs(b.x - bounds.x) + Math.abs(b.y - bounds.y)) ||
        a.y - b.y ||
        a.x - b.x,
    )
    .find((candidate) => !occupied.some((other) => intersectRect(candidate, other)));
}

export interface LayerQuotaCard {
  id: string;
  card: StoredLayerCard;
  renderKind: "notes" | "declarative" | "web" | "screenshot" | "utools";
}
export interface LayerQuotas {
  perPlugin: number;
  webPerPlugin: number;
  perDisplay: number;
  webPerDisplay: number;
  total: number;
  webTotal: number;
}
export const DEFAULT_LAYER_QUOTAS: Readonly<LayerQuotas> = {
  perPlugin: 8,
  webPerPlugin: 2,
  perDisplay: 20,
  webPerDisplay: 4,
  total: 64,
  webTotal: 8,
};
export function allocateLayerCards(
  candidates: readonly LayerQuotaCard[],
  quotas: LayerQuotas = DEFAULT_LAYER_QUOTAS,
): { active: string[]; suspended: Record<string, string> } {
  const active: string[] = [],
    suspended: Record<string, string> = {};
  const plugins = new Map<string, number>(),
    webPlugins = new Map<string, number>(),
    displays = new Map<string, number>(),
    webDisplays = new Map<string, number>();
  let webTotal = 0;
  for (const { id, card, renderKind } of [...candidates].sort(
    (a, b) => a.card.createdAt - b.card.createdAt || a.id.localeCompare(b.id),
  )) {
    if (!card.visible || !card.restore) continue;
    const plugin =
        card.kind === "widget" || card.kind === "utools"
          ? card.pluginId
          : card.kind === "screenshot"
            ? "spark233.screenshot"
            : "spark233.notes",
      web = renderKind === "web";
    if (
      active.length >= quotas.total ||
      (displays.get(card.displayId) ?? 0) >= quotas.perDisplay ||
      (plugins.get(plugin) ?? 0) >= quotas.perPlugin ||
      (web &&
        (webTotal >= quotas.webTotal ||
          (webDisplays.get(card.displayId) ?? 0) >= quotas.webPerDisplay ||
          (webPlugins.get(plugin) ?? 0) >= quotas.webPerPlugin))
    ) {
      suspended[id] = "layer.quotaExceeded";
      continue;
    }
    active.push(id);
    plugins.set(plugin, (plugins.get(plugin) ?? 0) + 1);
    displays.set(card.displayId, (displays.get(card.displayId) ?? 0) + 1);
    if (web) {
      webTotal++;
      webPlugins.set(plugin, (webPlugins.get(plugin) ?? 0) + 1);
      webDisplays.set(card.displayId, (webDisplays.get(card.displayId) ?? 0) + 1);
    }
  }
  return { active, suspended };
}
