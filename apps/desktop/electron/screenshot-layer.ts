import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginOwner } from "@spark233/sdk";
import type {
  LayerCard,
  LayerInstanceSummary,
  LayerPointerEvent,
} from "../shared/layer-contract.js";
import type { Rect } from "../src/features/capsules/types.js";
import type { DesktopLayer } from "./desktop-layer.js";
import {
  allocateLayerCards,
  constrainLayerCard,
  findLayerPlacement,
  type LayerLayoutStore,
  type LayerQuotaCard,
  type ScreenshotLayoutCard,
} from "./layer-layout-store.js";
import { AppError, atomicWrite, canonical, confined, inside } from "./persistence.js";
import { samePluginOwner, type PluginResourceScope } from "./plugins/resources.js";
import {
  checkedPng,
  type CaptureImage,
  type CapturePinImage,
  type CaptureRuntime,
} from "./plugins/official/capture.js";

const manifestSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  revision: z.uuid(),
  width: z.number().int().positive().max(16000),
  height: z.number().int().positive().max(16000),
  createdAt: z.number().int().nonnegative(),
});
type Manifest = z.infer<typeof manifestSchema>;
interface PinRecord {
  manifest: Manifest;
  handle: string;
}
interface Attachment {
  owner: PluginOwner;
  scope: PluginResourceScope;
  dataDir: string;
  cacheDir: string;
  edit: CaptureRuntime["editPin"];
}
interface Publication {
  attachment: Attachment;
  record: PinRecord;
  previous?: PinRecord;
  previousLayout?: ScreenshotLayoutCard;
  layoutCommitted: boolean;
  rollbackRequired?: boolean;
}
export interface ScreenshotLayerOptions {
  layer: DesktopLayer;
  store: LayerLayoutStore;
  flags: () => { enabled: boolean };
  isOwnerCurrent: (owner: PluginOwner, presentationOnly?: boolean) => boolean;
  otherQuotaCards: () => readonly LayerQuotaCard[];
  cursor: () => { x: number; y: number };
  toDip: (bounds: Rect) => Rect;
  toPhysical: (bounds: Rect) => Rect;
  changed?: () => void;
  onImage?: (image: CaptureImage) => void;
  onImageReleased?: (id: string) => void;
  diagnostic: (code: string, detail: unknown) => void;
}

/** Screenshot bodies stay in the plugin's private data directory. The existing
 * layout store, allocator, shared surfaces and editor own their presentation. */
export class ScreenshotLayerCoordinator {
  private attachment?: Attachment;
  private records = new Map<string, PinRecord>();
  private failures = new Map<string, string>();
  private publications = new Map<string, Publication>();
  private editingId?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private gesture?: { id: string; pointer: number; origin: Rect; start: { x: number; y: number } };
  private previews = new Map<string, Rect>();
  private readonly releaseConsumer: () => void;
  private readonly releaseStore: () => void;
  private disposed = false;

  constructor(private readonly options: ScreenshotLayerOptions) {
    this.releaseConsumer = options.layer.register({
      id: "trusted-screenshots",
      snapshot: () => this.cards(),
      onPointer: (event) => this.pointer(event),
      onPointersCancelled: () => this.cancelGesture(),
      onInvoke: (id, action, args) => this.invoke(id, action, args),
    });
    this.releaseStore = options.store.subscribe(() => this.refresh());
  }
  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private active(presentationOnly = false): boolean {
    const a = this.attachment;
    return (
      !this.disposed &&
      !!a &&
      a.scope.state === "active" &&
      this.options.isOwnerCurrent(a.owner, presentationOnly)
    );
  }
  private requireActive(): Attachment {
    if (!this.active() || !this.options.flags().enabled)
      throw new AppError("pluginStopping", "截图贴图当前不可用");
    return this.attachment!;
  }
  private pinRoot(a: Attachment, id: string): string {
    const pins = confined(a.dataDir, "pins");
    fs.mkdirSync(pins, { recursive: true });
    if (!inside(a.dataDir, canonical(pins)))
      throw new AppError("permissionDenied", "截图目录超出私有数据域");
    const root = confined(pins, z.uuid().parse(id));
    if (fs.existsSync(root) && !inside(a.dataDir, canonical(root)))
      throw new AppError("permissionDenied", "截图目录链接超出私有数据域");
    return root;
  }
  private file(
    a: Attachment,
    record: PinRecord,
    name: "preview.png" | "source.png" | "document.json",
  ): string {
    const root = this.pinRoot(a, record.manifest.id);
    const candidate = confined(root, `revisions/${record.manifest.revision}/${name}`);
    const real = fs.realpathSync(candidate);
    if (
      !inside(canonical(a.dataDir), real) ||
      !inside(canonical(root), real) ||
      !fs.statSync(real).isFile()
    )
      throw new AppError("permissionDenied", "截图贴图资源超出私有数据目录");
    return real;
  }
  private resource(a: Attachment, record: PinRecord): CaptureImage {
    const imagePath = this.file(a, record, "preview.png");
    return {
      owner: a.owner,
      sessionId: record.manifest.id,
      path: imagePath,
      width: record.manifest.width,
      height: record.manifest.height,
      resource: {
        id: `${a.owner.pluginId}:${a.owner.instanceId}:pin:${record.handle}`,
        kind: "image",
        mimeType: "image/png",
        size: fs.statSync(imagePath).size,
      },
    };
  }
  private releaseImage(a: Attachment, record: PinRecord): void {
    this.options.onImageReleased?.(
      `${a.owner.pluginId}:${a.owner.instanceId}:pin:${record.handle}`,
    );
  }
  attach(attachment: Attachment): void {
    if (this.attachment) this.detach(this.attachment.owner);
    this.attachment = {
      ...attachment,
      dataDir: canonical(attachment.dataDir),
      cacheDir: canonical(attachment.cacheDir),
    };
    this.reload();
    attachment.scope.own("event", {
      prepareStop: async () => {
        this.cancelGesture();
        await this.flush();
        this.refresh();
        return { ok: true };
      },
      cancelStop: () => this.refresh(),
      dispose: () => this.detach(attachment.owner),
    });
  }
  detach(owner: PluginOwner): void {
    if (!this.attachment || !samePluginOwner(owner, this.attachment.owner)) return;
    this.cancelGesture();
    for (const record of this.records.values()) this.releaseImage(this.attachment, record);
    this.attachment = undefined;
    this.records.clear();
    this.failures.clear();
    this.refresh();
  }
  private layouts(): ScreenshotLayoutCard[] {
    return Object.values(this.options.store.load().cards).filter(
      (card): card is ScreenshotLayoutCard => card.kind === "screenshot",
    );
  }
  private loadRecord(id: string): PinRecord {
    const a = this.attachment!;
    const filename = confined(this.pinRoot(a, id), "current.json");
    if (fs.statSync(filename).size > 4096) throw new Error("Screenshot manifest exceeds budget");
    const real = fs.realpathSync(filename);
    if (!inside(canonical(a.dataDir), real))
      throw new Error("Screenshot manifest escaped private storage");
    const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(real, "utf8")));
    if (manifest.id !== id || manifest.width * manifest.height > 32_000_000)
      throw new Error("Screenshot manifest identity/dimensions invalid");
    const record = { manifest, handle: randomUUID() };
    const image = checkedPng(this.file(a, record, "preview.png"));
    const source = checkedPng(this.file(a, record, "source.png"));
    if (
      image.size > 32 * 1024 * 1024 ||
      image.width !== manifest.width ||
      image.height !== manifest.height ||
      source.width !== image.width ||
      source.height !== image.height
    )
      throw new Error("Screenshot image differs from its document");
    this.document(this.file(a, record, "document.json"), manifest.width, manifest.height);
    return record;
  }
  private document(filename: string, width: number, height: number): Buffer {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error("Screenshot document exceeds budget");
    const bytes = fs.readFileSync(filename);
    const document = JSON.parse(bytes.toString("utf8"));
    if (
      document?.format !== "spark233-pin" ||
      document.version !== 1 ||
      document.width !== width ||
      document.height !== height ||
      !Array.isArray(document.shapes) ||
      document.shapes.length > 10000
    )
      throw new Error("Screenshot editable document is invalid");
    return bytes;
  }
  reload(): void {
    const a = this.attachment;
    if (!a) return;
    for (const record of this.records.values()) this.releaseImage(a, record);
    this.records.clear();
    this.failures.clear();
    for (const card of this.layouts()) {
      try {
        const record = this.loadRecord(card.screenshotId);
        this.records.set(card.screenshotId, record);
        this.options.onImage?.(this.resource(a, record));
      } catch (error) {
        this.failures.set(
          card.screenshotId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.refresh();
  }
  refresh(): void {
    if (
      !this.active(true) ||
      !this.options.flags().enabled ||
      (this.gesture && !this.options.layer.isCardVisible(`screenshot:${this.gesture.id}`))
    )
      this.cancelGesture(false);
    this.options.layer.refresh();
    this.options.changed?.();
  }
  quotaCards(): LayerCard[] {
    // Presentation is queried on every shared-layer drag frame, including when
    // there are no pins. Commands and image reads retain fresh package checks.
    if (!this.records.size || !this.active(true)) return [];
    return this.layouts().flatMap((stored) => {
      const record = this.records.get(stored.screenshotId);
      if (!record) return [];
      const card = this.constrain(stored);
      return [
        {
          id: `screenshot:${stored.screenshotId}`,
          consumerId: "trusted-screenshots",
          displayId: card.displayId,
          bounds: card.bounds,
          group: card.group,
          inputMode: card.inputMode,
          visible: card.visible && card.restore,
          order: card.order,
          renderKind: "screenshot" as const,
          renderRef: stored.screenshotId,
        },
      ];
    });
  }
  private candidates(layouts = this.layouts()): LayerQuotaCard[] {
    return layouts
      .filter((card) => this.records.has(card.screenshotId))
      .map((card) => ({
        id: `screenshot:${card.screenshotId}`,
        card: this.constrain(card),
        renderKind: "screenshot",
      }));
  }
  private allocation(layouts = this.layouts()) {
    return allocateLayerCards([...this.options.otherQuotaCards(), ...this.candidates(layouts)]);
  }
  private cards(): LayerCard[] {
    if (!this.records.size || !this.active(true)) return [];
    const active = new Set(this.allocation().active);
    // Hidden pins may be positioned in the shared editor, within the same
    // quotas. Visible cards reserve their places before hidden candidates.
    const editable = new Set(
      allocateLayerCards([
        ...this.options.otherQuotaCards(),
        ...this.candidates().map((entry) =>
          entry.card.visible
            ? entry
            : {
                ...entry,
                card: { ...entry.card, visible: true, createdAt: Number.MAX_SAFE_INTEGER },
              },
        ),
      ]).active,
    );
    return this.quotaCards()
      .filter(
        (card) =>
          (active.has(card.id) || (!card.visible && editable.has(card.id))) &&
          (this.editingId !== card.renderRef || this.publications.has(card.renderRef!)),
      )
      .map((card) => {
        const record = this.records.get(card.renderRef!)!;
        return {
          ...card,
          bounds: this.previews.get(card.renderRef!) ?? card.bounds,
          title: "截图贴图",
          screenshot: {
            imageUrl: `spark233://app/__screenshot-image/${record.handle}`,
            pixelWidth: record.manifest.width,
            pixelHeight: record.manifest.height,
            editable: !this.publications.has(card.renderRef!) && this.editingId !== card.renderRef,
          },
        };
      });
  }
  list(): LayerInstanceSummary[] {
    const allocation = this.active() ? this.allocation() : undefined;
    return this.layouts().map((card) => ({
      widgetInstanceId: card.screenshotId,
      pluginId: "spark233.screenshot",
      widgetDefinitionId: "screenshot-pin",
      title: `截图贴图 · ${this.records.get(card.screenshotId)?.manifest.width ?? "?"} × ${this.records.get(card.screenshotId)?.manifest.height ?? "?"}`,
      displayId: card.displayId,
      visible: card.visible,
      bounds: card.bounds,
      group: card.group,
      inputMode: card.inputMode,
      status: !this.active()
        ? "orphan"
        : this.failures.has(card.screenshotId) ||
            this.options.layer.surfaceFailure(`screenshot:${card.screenshotId}`)
          ? "fault"
          : !card.visible || !this.options.flags().enabled
            ? "hidden"
            : allocation?.suspended[`screenshot:${card.screenshotId}`]
              ? "suspended"
              : "active",
      reason:
        this.failures.get(card.screenshotId) ??
        this.options.layer.surfaceFailure(`screenshot:${card.screenshotId}`) ??
        (!this.options.flags().enabled
          ? "Desktop cards are disabled"
          : allocation?.suspended[`screenshot:${card.screenshotId}`]),
    }));
  }
  has(id: string): boolean {
    return this.layouts().some((card) => card.screenshotId === id);
  }
  private imageVisible(id: string): boolean {
    const cardId = `screenshot:${id}`;
    // Image loads also belong to the unified layout editor; action visibility
    // deliberately fences that editor and is therefore too restrictive here.
    // Native suppression (lock/suspend) only hides presentation. Authorize the
    // current logical surface so its first paint can finish before it is shown.
    const surface = this.options.layer.surfaceForCard(cardId);
    return (
      !!surface &&
      this.options.layer
        .snapshot(surface)
        .cards.some(
          (card) => card.id === cardId && card.visible && card.renderKind === "screenshot",
        )
    );
  }
  async resolveImage(handle: string): Promise<Buffer | undefined> {
    if (!this.active() || !this.options.flags().enabled) return;
    const record = [...this.records.values()].find((entry) => entry.handle === handle);
    if (!record || !this.imageVisible(record.manifest.id)) return;
    const a = this.attachment!;
    const filename = this.file(a, record, "preview.png");
    const checked = checkedPng(filename);
    if (
      checked.size > 32 * 1024 * 1024 ||
      checked.width !== record.manifest.width ||
      checked.height !== record.manifest.height
    )
      return;
    const bytes = await fs.promises.readFile(filename);
    if (
      !this.active() ||
      this.attachment !== a ||
      this.records.get(record.manifest.id) !== record ||
      !this.imageVisible(record.manifest.id)
    )
      return;
    return bytes;
  }
  private constrain(card: ScreenshotLayoutCard): ScreenshotLayoutCard {
    return constrainLayerCard(
      card,
      this.options.layer.options.displays(),
      this.options.layer.options.primaryDisplay(),
    ).card as ScreenshotLayoutCard;
  }
  private place(card: ScreenshotLayoutCard): ScreenshotLayoutCard {
    const displays = this.options.layer.options.displays();
    const display = displays.find((item) => item.id === card.displayId) ?? displays[0];
    if (!display) throw new AppError("layer.displayUnavailable", "显示器当前不可用");
    const ratio = Math.min(
      1,
      display.workArea.width / card.bounds.width,
      display.workArea.height / card.bounds.height,
    );
    card = this.constrain({
      ...card,
      displayId: display.id,
      workAreaAtSave: display.workArea,
      bounds: {
        ...card.bounds,
        width: Math.max(1, card.bounds.width * ratio),
        height: Math.max(1, card.bounds.height * ratio),
      },
    });
    const occupied = this.options.layer
      .snapshot()
      .cards.filter(
        (item) =>
          item.id !== `screenshot:${card.screenshotId}` &&
          item.visible &&
          item.displayId === card.displayId &&
          (item.group !== card.group || item.inputMode !== card.inputMode),
      )
      .map((item) => item.bounds);
    const placed = findLayerPlacement(card.bounds, display.workArea, occupied);
    if (!placed)
      throw new AppError("layer.noSpace", "当前显示器没有足够位置，请先移动部分桌面卡片");
    return { ...card, bounds: placed };
  }
  publish(image: CapturePinImage, isCurrent: () => boolean): Promise<string> {
    return this.serial(async () => {
      await this.retryRollbacks();
      const a = this.requireActive();
      const current = () =>
        this.attachment === a && this.active() && this.options.flags().enabled && isCurrent();
      if (
        !samePluginOwner(a.owner, image.owner) ||
        !current() ||
        this.options.layer.snapshot().editing
      )
        throw new AppError("pluginStopping", "请先完成桌面编辑再固定截图");
      for (const file of [image.path, image.sourcePath, image.documentPath])
        if (!inside(a.cacheDir, fs.realpathSync(file)))
          throw new AppError("permissionDenied", "截图交接文件超出当前私有会话");
      const png = checkedPng(image.path),
        source = checkedPng(image.sourcePath);
      if (
        png.size > 32 * 1024 * 1024 ||
        png.width > 16000 ||
        png.height > 16000 ||
        png.width * png.height > 32_000_000 ||
        png.width !== image.width ||
        png.height !== image.height ||
        source.width !== png.width ||
        source.height !== png.height
      )
        throw new Error("Pinned image dimensions invalid");
      const document = this.document(image.documentPath, png.width, png.height);
      const id = this.editingId ?? randomUUID(),
        previous = this.records.get(id);
      const before = this.options.store.load();
      const previousLayout = before.cards[`screenshot:${id}`] as ScreenshotLayoutCard | undefined;
      const record: PinRecord = {
        handle: randomUUID(),
        manifest: {
          version: 1,
          id,
          revision: randomUUID(),
          width: png.width,
          height: png.height,
          createdAt: previous?.manifest.createdAt ?? Date.now(),
        },
      };
      this.records.set(id, record);
      try {
        const bounds = this.options.toDip(image.bounds);
        if (
          ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
          bounds.width <= 0 ||
          bounds.height <= 0
        )
          throw new Error("Pinned window bounds invalid");
        const displays = this.options.layer.options.displays();
        const display =
          displays.find(
            (d) =>
              bounds.x + bounds.width / 2 >= d.workArea.x &&
              bounds.x + bounds.width / 2 < d.workArea.x + d.workArea.width &&
              bounds.y + bounds.height / 2 >= d.workArea.y &&
              bounds.y + bounds.height / 2 < d.workArea.y + d.workArea.height,
          ) ??
          displays.find((d) => d.id === this.options.layer.options.primaryDisplay()) ??
          displays[0];
        if (!display) throw new Error("No display available");
        const stored = this.place({
          kind: "screenshot",
          screenshotId: id,
          displayId: display.id,
          workAreaAtSave: display.workArea,
          bounds,
          group: previousLayout?.group ?? "top",
          inputMode: previousLayout?.inputMode ?? "interactive",
          order: previousLayout?.order ?? Object.keys(before.cards).length,
          visible: true,
          restore: true,
          createdAt: record.manifest.createdAt,
        });
        const candidates = [...this.layouts().filter((card) => card.screenshotId !== id), stored];
        if (this.allocation(candidates).suspended[`screenshot:${id}`])
          throw new AppError("layer.quotaExceeded", "桌面贴图数量超过配额，请先关闭部分卡片");
        this.publications.set(id, {
          attachment: a,
          record,
          previous,
          previousLayout,
          layoutCommitted: false,
        });
        const directory = confined(this.pinRoot(a, id), `revisions/${record.manifest.revision}`);
        fs.mkdirSync(directory, { recursive: true });
        atomicWrite(confined(directory, "preview.png"), fs.readFileSync(png.path));
        atomicWrite(confined(directory, "source.png"), fs.readFileSync(source.path));
        atomicWrite(confined(directory, "document.json"), document);
        atomicWrite(confined(this.pinRoot(a, id), "current.json"), JSON.stringify(record.manifest));
        if (!current()) throw new Error("Screenshot owner changed before commit");
        before.cards[`screenshot:${id}`] = stored;
        before.revision++;
        await this.options.store.commit(before, before.revision - 1);
        this.publications.get(id)!.layoutCommitted = true;
        if (previous) this.releaseImage(a, previous);
        this.options.onImage?.(this.resource(a, record));
        this.refresh();
        const deadline = Date.now() + 5000;
        while (!this.options.layer.isCardReady(`screenshot:${id}`)) {
          if (!current() || Date.now() >= deadline)
            throw new Error("截图桌面窗口未就绪，原编辑器已保留");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!current()) throw new Error("Screenshot handoff cancelled");
        return id;
      } catch (error) {
        const pending = this.publications.get(id);
        if (pending) {
          pending.rollbackRequired = true;
          await this.rollbackInside(id);
        } else {
          if (previous) this.records.set(id, previous);
          else this.records.delete(id);
          this.refresh();
        }
        throw error;
      }
    });
  }
  private removeRevision(a: Attachment, record: PinRecord): void {
    const directory = confined(
      this.pinRoot(a, record.manifest.id),
      `revisions/${record.manifest.revision}`,
    );
    if (fs.existsSync(directory) && inside(canonical(a.dataDir), canonical(directory)))
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
  private async rollbackInside(id: string): Promise<void> {
    const pending = this.publications.get(id);
    if (!pending) return;
    const { attachment: a, record, previous, previousLayout } = pending;
    pending.rollbackRequired = true;
    if (pending.layoutCommitted) {
      const state = this.options.store.load();
      if (previousLayout) state.cards[`screenshot:${id}`] = previousLayout;
      else delete state.cards[`screenshot:${id}`];
      state.revision++;
      await this.options.store.commit(state, state.revision - 1);
      pending.layoutCommitted = false;
    }
    this.releaseImage(a, record);
    if (previous) {
      atomicWrite(confined(this.pinRoot(a, id), "current.json"), JSON.stringify(previous.manifest));
      this.records.set(id, previous);
      this.options.onImage?.(this.resource(a, previous));
    } else {
      this.records.delete(id);
      fs.rmSync(confined(this.pinRoot(a, id), "current.json"), { force: true });
    }
    this.removeRevision(a, record);
    this.publications.delete(id);
    this.refresh();
  }
  private async retryRollbacks(): Promise<void> {
    for (const [id, pending] of this.publications)
      if (pending.rollbackRequired) await this.rollbackInside(id);
  }
  abortPublication(id: string): Promise<void> {
    return this.serial(() => this.rollbackInside(id));
  }
  acknowledgePublication(id: string): Promise<void> {
    return this.serial(() => {
      const pending = this.publications.get(id);
      if (!pending) return;
      this.publications.delete(id);
      if (pending.previous) this.removeRevision(pending.attachment, pending.previous);
      this.refresh();
    });
  }
  update(
    id: string,
    patch: Partial<
      Pick<ScreenshotLayoutCard, "bounds" | "displayId" | "group" | "inputMode" | "visible">
    >,
  ): Promise<void> {
    return this.serial(async () => {
      this.requireActive();
      if (
        this.publications.has(id) ||
        this.editingId === id ||
        this.options.layer.snapshot().editing
      )
        throw new AppError("layer.busy", "请先完成当前桌面操作");
      if (this.gesture?.id === id) this.cancelGesture();
      const state = this.options.store.load(),
        old = state.cards[`screenshot:${id}`];
      if (old?.kind !== "screenshot") throw new AppError("layer.card.invalid", "截图贴图不存在");
      let card = { ...old, ...patch };
      if (patch.displayId || patch.bounds) {
        const display = this.options.layer.options.displays().find((d) => d.id === card.displayId);
        if (!display) throw new AppError("layer.displayUnavailable", "显示器当前不可用");
        card.workAreaAtSave = display.workArea;
      }
      card = this.place(card);
      if (
        card.visible &&
        this.allocation(this.layouts().map((entry) => (entry.screenshotId === id ? card : entry)))
          .suspended[`screenshot:${id}`]
      )
        throw new AppError("layer.quotaExceeded", "桌面贴图数量超过配额");
      state.cards[`screenshot:${id}`] = card;
      state.revision++;
      await this.options.store.commit(state, state.revision - 1);
      this.refresh();
    });
  }
  close(id: string): Promise<void> {
    return this.serial(async () => {
      const a = this.attachment;
      if (
        this.publications.has(id) ||
        this.editingId === id ||
        this.options.layer.snapshot().editing
      )
        throw new AppError("layer.busy", "请先完成截图编辑");
      this.cancelGesture();
      await this.options.store.removeScreenshot(id);
      const record = this.records.get(id);
      if (record && a) this.releaseImage(a, record);
      this.records.delete(id);
      this.failures.delete(id);
      if (a) {
        const root = this.pinRoot(a, id);
        if (fs.existsSync(root) && inside(canonical(a.dataDir), canonical(root)))
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      }
      this.refresh();
    });
  }
  retry(id: string): Promise<void> {
    return this.serial(() => {
      this.requireActive();
      const record = this.loadRecord(id);
      const old = this.records.get(id);
      if (old) this.releaseImage(this.attachment!, old);
      this.records.set(id, record);
      this.failures.delete(id);
      this.options.onImage?.(this.resource(this.attachment!, record));
      this.options.layer.retryCard(`screenshot:${id}`);
      this.refresh();
    });
  }
  private async edit(id: string): Promise<void> {
    const a = this.requireActive(),
      record = this.records.get(id);
    if (!record || this.editingId || this.publications.has(id))
      throw new AppError("layer.busy", "截图编辑尚未完成");
    const card = this.layouts().find((entry) => entry.screenshotId === id)!;
    this.cancelGesture();
    this.editingId = id;
    this.refresh();
    try {
      await a.edit({
        sourcePath: this.file(a, record, "source.png"),
        documentPath: this.file(a, record, "document.json"),
        bounds: this.options.toPhysical(this.constrain(card).bounds),
      });
    } finally {
      this.editingId = undefined;
      this.refresh();
    }
  }
  private async zoom(id: string, factor?: number): Promise<void> {
    const card = this.layouts().find((entry) => entry.screenshotId === id),
      record = this.records.get(id);
    if (!card || !record) throw new Error("Screenshot pin is missing");
    const current = this.constrain(card),
      display = this.options.layer.options.displays().find((d) => d.id === current.displayId)!;
    const ratio =
      factor ??
      Math.min(
        (display.workArea.width * 0.7) / current.bounds.width,
        (display.workArea.height * 0.7) / current.bounds.height,
      );
    const scale = Math.max(0.1, Math.min(8, ratio));
    const width = Math.max(80, current.bounds.width * scale),
      height = (width * record.manifest.height) / record.manifest.width;
    await this.update(id, {
      bounds: {
        x: current.bounds.x + (current.bounds.width - width) / 2,
        y: current.bounds.y + (current.bounds.height - height) / 2,
        width,
        height,
      },
    });
  }
  private async invoke(
    cardId: string,
    action: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireActive();
    const id = cardId.slice("screenshot:".length);
    if (!cardId.startsWith("screenshot:") || !this.has(id))
      throw new AppError("permissionDenied", "截图贴图不属于当前展示");
    if (action === "edit") return this.edit(id);
    if (action === "close") return this.close(id);
    if (action === "hide") {
      this.cancelGesture();
      return this.update(id, { visible: false });
    }
    if (action === "pin") {
      const card = this.layouts().find((entry) => entry.screenshotId === id)!;
      return this.update(id, { group: card.group === "top" ? "normal" : "top" });
    }
    if (action === "zoom")
      return this.zoom(id, z.number().finite().min(0.25).max(4).parse(args.value));
    if (action === "fit") return this.zoom(id);
    throw new AppError("permissionDenied", "不支持的截图操作");
  }
  private cancelGesture(refresh = true): void {
    if (!this.gesture && !this.previews.size) return;
    this.gesture = undefined;
    this.previews.clear();
    if (refresh) this.options.layer.refresh();
  }
  private async pointer(event: LayerPointerEvent): Promise<void> {
    if (!this.active() || !this.options.flags().enabled) {
      this.cancelGesture();
      return;
    }
    const id = event.cardId.slice("screenshot:".length);
    if (this.publications.has(id) || this.editingId || this.options.layer.snapshot().editing) {
      this.cancelGesture();
      return;
    }
    if (event.type === "doubleclick" || event.type === "contextmenu") {
      this.cancelGesture();
      return this.edit(id);
    }
    if (event.type === "wheel") return this.zoom(id, event.deltaY && event.deltaY > 0 ? 0.8 : 1.25);
    if (event.type === "cancel") {
      this.cancelGesture();
      return;
    }
    if (event.type === "down" && event.button === "left") {
      const card = this.layouts().find((entry) => entry.screenshotId === id);
      if (card)
        this.gesture = {
          id,
          pointer: event.pointerId,
          origin: this.constrain(card).bounds,
          start: { x: event.screenX, y: event.screenY },
        };
      return;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.id !== id || gesture.pointer !== event.pointerId) return;
    if (event.type !== "move" && event.type !== "up") return;
    const cursor = this.options.cursor();
    const bounds = {
      ...gesture.origin,
      x: gesture.origin.x + cursor.x - gesture.start.x,
      y: gesture.origin.y + cursor.y - gesture.start.y,
    };
    if (event.type === "move") {
      this.previews.set(id, bounds);
      this.options.layer.refresh();
      return;
    }
    this.cancelGesture();
    const displays = this.options.layer.options.displays(),
      center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const distance = (d: (typeof displays)[number]) =>
      Math.hypot(
        center.x - Math.max(d.workArea.x, Math.min(d.workArea.x + d.workArea.width, center.x)),
        center.y - Math.max(d.workArea.y, Math.min(d.workArea.y + d.workArea.height, center.y)),
      );
    const display = [...displays].sort((a, b) => distance(a) - distance(b))[0];
    await this.update(id, { bounds, ...(display ? { displayId: display.id } : {}) });
  }
  flush(): Promise<void> {
    return this.serial(async () => {
      await this.retryRollbacks();
      await this.options.store.flush();
    });
  }
  async dispose(): Promise<void> {
    await this.flush();
    if (this.attachment) this.detach(this.attachment.owner);
    this.disposed = true;
    this.releaseConsumer();
    this.releaseStore();
  }
}
