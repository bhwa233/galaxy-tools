import {
  Menu,
  session,
  systemPreferences,
  type CustomScheme,
  type MenuItemConstructorOptions,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  parseWidgetEnvelope,
  parseWidgetData,
  sameWidgetBinding,
  type JsonValue,
  type PluginOwner,
  type PluginPackageMetadata,
  type PluginWidget,
  type WidgetBinding,
  type WidgetDataFrame,
  type WidgetEnvelope,
  type WidgetInit,
  type WidgetValue,
} from "@spark233/sdk";
import type {
  LayerCard,
  LayerManagementState,
  LayerPointerEvent,
} from "../../shared/layer-contract.js";
import type { Rect } from "../../src/features/capsules/types.js";
import { contains, intersectRect } from "../capsule-layout.js";
import type { DesktopLayer, LayerSurfaceSpec } from "../desktop-layer.js";
import {
  LayerLayoutStore,
  allocateLayerCards,
  constrainLayerCard,
  findLayerPlacement,
  type WidgetLayoutCard,
  type LayerQuotaCard,
} from "../layer-layout-store.js";
import { AppError, confined, inside } from "../persistence.js";
import type { DesktopPluginHost } from "./desktop-host.js";
import { samePluginOwner } from "./resources.js";
import type { ResolvedWidgetEntry } from "./manifest.js";
import { WidgetOpenMainGate } from "./widget-open-main.js";

export const widgetScheme: CustomScheme = {
  scheme: "spark233-widget",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    allowServiceWorkers: false,
    bypassCSP: false,
  },
};
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
interface SourceEvent {
  owner: PluginOwner;
  source: "backend" | "native";
  entryId?: string;
  name: string;
  payload?: JsonValue;
}
interface RuntimeCard {
  id: string;
  stored: WidgetLayoutCard;
  definition: PluginWidget;
  entry: ResolvedWidgetEntry;
  binding: WidgetBinding;
  data: WidgetDataFrame;
  values: Record<string, WidgetValue>;
  ready: boolean;
  nonce: string;
  hostname: string;
  seq: number;
  incoming: number;
  lastBeat: number;
  lastSent: number;
  status: "active" | "fault" | "suspended";
  reason?: string;
  release?: () => void;
  pending: Map<string, AbortController>;
  lastInvoke: number;
  attachActions: Set<string>;
  surfaceId?: string;
  receiveWindow: number;
  receiveCount: number;
  nativeEntry?: string;
  images?: Record<string, string>;
  contentHeight?: number;
  interaction?: {
    pointerTarget?: string;
    hoverAt?: number;
    leaveAt?: number;
    preview: boolean;
    edgeHidden: boolean;
    menuOpen: boolean;
    menu?: Menu;
    bounds?: Rect;
    previewHeight?: number;
    edgeBounds?: Rect;
    edgeMotion?: { from: Rect; to: Rect; startedAt: number };
  };
  handshakeAt?: number;
  environment?: {
    theme: "light" | "dark";
    locale: string;
    scaleFactor: number;
    width: number;
    height: number;
    visible: boolean;
  };
  providerAttached: boolean;
  providerTransition?: Promise<void>;
  providerFailures: number;
  providerRetryAt: number;
}
export interface WidgetHostOptions {
  layer: DesktopLayer;
  store: LayerLayoutStore;
  pluginHost: () => DesktopPluginHost | undefined;
  rendererRoot: string;
  devUrl?: string;
  locale: () => string;
  theme: () => "light" | "dark";
  flags: () => { enabled: boolean; webEnabled: boolean; notesEnabled: boolean };
  notesActive?: () => boolean;
  notesCards?: () => readonly LayerCard[];
  trustedCards?: () => readonly LayerCard[];
  resolveScreenshotImage?: (handle: string) => Promise<Buffer | undefined>;
  diagnostic: (code: string, detail: JsonValue) => void;
}

/** The existing plugin manager owns permission and process lifetime. This adapter
 * only binds widget instances, bounded display data, and restricted resources. */
export class WidgetHost {
  private records = new Map<string, RuntimeCard>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private clock: ReturnType<typeof setInterval>;
  private edgeFrame?: ReturnType<typeof setTimeout>;
  private releaseConsumer: () => void;
  private releaseStore: () => void;
  private generation = 0;
  private tokens = 50 * 1024;
  private tokenAt = Date.now();
  private pluginTokens = new Map<string, { tokens: number; at: number }>();
  private suspensions = new Map<string, string>();
  private nextRecord = 0;
  private clockSample = { at: 0, locale: "", text: "" };
  private openMainGate: WidgetOpenMainGate;
  private drag?: {
    record: RuntimeCard;
    pointerId: number;
    origin: Rect;
    start: { x: number; y: number };
    moved: boolean;
    committing?: boolean;
  };
  constructor(readonly options: WidgetHostOptions) {
    this.openMainGate = new WidgetOpenMainGate((candidate) =>
      options.layer.send(candidate.surfaceId, {
        type: "widget-open-main-cleared",
        candidateId: candidate.candidateId,
      }),
    );
    this.releaseConsumer = options.layer.register({
      id: "widgets",
      snapshot: () => this.cards(),
      onPointer: (event) => this.pointer(event),
      onPointersCancelled: () => this.cancelInteractions(),
      onContentHeight: (cardId, height) => {
        const main = [...this.records.values()].find((record) => cardId === record.id);
        if (
          main?.definition.kind === "declarative" &&
          main.definition.contentHeight &&
          main.status === "active" &&
          !this.drag &&
          this.host().manager.isOwnerCurrent(main.binding.owner, undefined, true)
        ) {
          const next = Math.max(
            main.definition.minSize?.height ?? 32,
            Math.min(main.definition.maxSize?.height ?? 900, Math.ceil(height)),
          );
          if (main.contentHeight === next) return;
          main.contentHeight = next;
          this.cancelEdgeMotion(main);
          this.options.layer.refresh();
          return;
        }
        const r = [...this.records.values()].find((record) => cardId === record.id + ":hover");
        const maximum = r && this.interactionDefinition(r)?.hover?.size.height;
        if (
          !r?.interaction?.preview ||
          !maximum ||
          r.status !== "active" ||
          !this.host().manager.isOwnerCurrent(r.binding.owner, undefined, true)
        )
          return;
        const next = Math.min(maximum, Math.ceil(height));
        if (r.interaction.previewHeight === next) return;
        r.interaction.previewHeight = next;
        this.options.layer.refresh();
      },
    });
    this.releaseStore = options.store.subscribe(() => {
      void this.sync();
    });
    options.layer.onAction = (id, action, input, gesture) =>
      this.invoke(id, action, input, gesture);
    options.layer.onRelay = (surface, binding, wire) => this.acceptWire(surface, binding, wire);
    options.layer.onReady = (surface, id) => {
      if (id) this.readySurface(surface, id);
    };
    options.layer.onConfirmOpen = (surface, cardId, candidateId, allow) =>
      this.confirmOpenMain(surface, cardId, candidateId, allow);
    this.clock = setInterval(() => this.tick(), 250);
    this.clock.unref();
  }
  private host(): DesktopPluginHost {
    const h = this.options.pluginHost();
    if (!h) throw new AppError("pluginUnavailable", "Plugin host is not ready");
    return h;
  }
  private allocate(candidates: readonly LayerQuotaCard[]) {
    const displays = this.options.layer.options.displays();
    const stored = this.options.store.load();
    // Reservations come from trusted consumers' logical snapshots, including
    // temporarily suppressed views. Do not infer eligibility from rendered frames.
    const trusted =
      this.options.trustedCards?.() ??
      (this.options.notesActive?.() ? (this.options.notesCards?.() ?? []) : []);
    const reservations: LayerQuotaCard[] = trusted.flatMap((card): LayerQuotaCard[] => {
      const display = displays.find((item) => item.id === card.displayId);
      if (!card.renderRef || !card.visible || !display) return [];
      if (card.renderKind === "screenshot") {
        const saved = stored.cards[card.id];
        if (saved?.kind !== "screenshot" || saved.screenshotId !== card.renderRef) return [];
        return [
          {
            id: card.id,
            renderKind: "screenshot" as const,
            card: {
              ...saved,
              displayId: display.id,
              bounds: card.bounds,
              workAreaAtSave: display.workArea,
              group: card.group,
              inputMode: card.inputMode,
              visible: card.visible,
              order: card.order,
            },
          },
        ];
      }
      if (card.renderKind !== "notes" || this.options.notesActive?.() === false) return [];
      return [
        {
          id: card.id,
          renderKind: "notes" as const,
          card: {
            kind: "notes" as const,
            noteId: card.renderRef,
            displayId: display.id,
            workAreaAtSave: display.workArea,
            bounds: card.bounds,
            group: card.group,
            inputMode: card.inputMode,
            visible: true,
            restore: true,
            order: card.order,
            createdAt: 0,
          },
        },
      ];
    });
    // Existing notes keep their view. Over-budget widgets suspend without
    // deleting either domain's layout, including after displays are merged.
    const allocation = allocateLayerCards([...reservations, ...candidates]);
    return {
      active: allocation.active.filter((id) => id.startsWith("widget:")),
      suspended: Object.fromEntries(
        Object.entries(allocation.suspended).filter(([id]) => id.startsWith("widget:")),
      ),
    };
  }
  /** Display-only logical candidates for other trusted consumers' quota checks.
   * Actions and attachment still perform the manager's fresh execution checks. */
  quotaCards(): LayerQuotaCard[] {
    const host = this.options.pluginHost();
    if (this.disposed || !host || !this.options.flags().enabled || this.options.store.readError)
      return [];
    const installed = host.manager.list();
    const metadata = new Map<string, PluginPackageMetadata>();
    return Object.entries(this.options.store.load().cards).flatMap(([id, stored]) => {
      if (stored.kind !== "widget" || !stored.visible || !stored.restore) return [];
      const installation = installed.find((entry) => entry.pluginId === stored.pluginId);
      if (!installation?.enabled || installation.lastError) return [];
      try {
        let described = metadata.get(stored.pluginId);
        if (!described) {
          described = host.manager.describe(stored.pluginId, true);
          metadata.set(stored.pluginId, described);
        }
        const definition = described.spark233.ui?.widgets?.[stored.widgetDefinitionId];
        if (!definition || (definition.kind === "web" && !this.options.flags().webEnabled))
          return [];
        const card = constrainLayerCard(
          stored,
          this.options.layer.options.displays(),
          this.options.layer.options.primaryDisplay(),
        ).card;
        return [{ id, card, renderKind: definition.kind }];
      } catch {
        return [];
      }
    });
  }
  list(): LayerManagementState {
    if (this.options.store.readError)
      throw new AppError(
        "layer.layoutUnreadable",
        "Desktop layout could not be read; the original file is preserved",
      );
    const host = this.options.pluginHost();
    const state = this.options.store.load();
    const templates: LayerManagementState["templates"] = [];
    for (const installed of host?.manager.list() ?? []) {
      if (!installed.enabled || installed.lastError) continue;
      try {
        for (const [widgetDefinitionId, d] of Object.entries(
          host!.manager.describe(installed.pluginId).spark233.ui?.widgets ?? {},
        ))
          templates.push({
            pluginId: installed.pluginId,
            widgetDefinitionId,
            title: d.title,
            kind: d.kind,
            quota: {
              active: [...this.records.values()].filter(
                (r) => r.stored.pluginId === installed.pluginId && r.status === "active",
              ).length,
              limit: 8,
            },
          });
      } catch {}
    }
    const instances = Object.values(state.cards)
      .filter((c): c is WidgetLayoutCard => c.kind === "widget")
      .map((c) => {
        const r = this.records.get(c.widgetInstanceId);
        const failure = this.options.layer.surfaceFailure("widget:" + c.widgetInstanceId);
        const installation = host?.manager.list().find((p) => p.pluginId === c.pluginId);
        const unavailable = !templates.some(
          (t) => t.pluginId === c.pluginId && t.widgetDefinitionId === c.widgetDefinitionId,
        );
        return {
          widgetInstanceId: c.widgetInstanceId,
          pluginId: c.pluginId,
          widgetDefinitionId: c.widgetDefinitionId,
          displayId: c.displayId,
          visible: c.visible,
          group: c.group,
          inputMode: c.inputMode,
          bounds: c.bounds,
          status: !c.visible
            ? ("hidden" as const)
            : failure
              ? ("fault" as const)
              : (r?.status ??
                (unavailable && installation?.enabled
                  ? ("orphan" as const)
                  : ("suspended" as const))),
          reason:
            (failure === "faulted"
              ? "Automatic recovery stopped; retry this card"
              : failure === "recovering"
                ? "Recovering desktop surface"
                : undefined) ??
            r?.reason ??
            this.suspensions.get(c.widgetInstanceId) ??
            (!this.options.flags().enabled
              ? "Desktop cards are disabled"
              : !installation?.enabled
                ? "Plugin is disabled or unavailable"
                : unavailable
                  ? "Widget template is unavailable"
                  : !r
                    ? "Widget is suspended"
                    : undefined),
        };
      });
    return { templates, instances };
  }
  async create(pluginId: string, definitionId: string): Promise<string> {
    if (!this.options.flags().enabled)
      throw new AppError("layer.disabled", "Enable desktop cards first");
    const host = this.host(),
      installed = host.manager.list(),
      installation = installed.find((p) => p.pluginId === pluginId);
    if (!installation?.enabled || installation.lastError)
      throw new AppError("pluginDisabled", "Plugin is disabled");
    // This operation validates each package once, even when many existing cards
    // share it. Attachment and command dispatch retain their own fresh checks.
    const metadata = new Map<string, PluginPackageMetadata>();
    const describe = (id: string) => {
      let value = metadata.get(id);
      if (!value) {
        value = host.manager.describe(id);
        metadata.set(id, value);
      }
      return value;
    };
    const definition = describe(pluginId).spark233.ui?.widgets?.[definitionId];
    if (!definition) throw new AppError("widget.notDeclared", "Unknown widget template");
    if (definition.kind === "web" && !this.options.flags().webEnabled)
      throw new AppError("widget.webDisabled", "Enable isolated Web cards first");
    const layout = this.options.store.load(),
      display =
        this.options.layer.options
          .displays()
          .find((d) => d.id === this.options.layer.options.primaryDisplay()) ??
        this.options.layer.options.displays()[0];
    if (!display) throw new Error("No display available");
    const bounds = findLayerPlacement(
      { x: display.workArea.x + 24, y: display.workArea.y + 24, ...definition.size },
      display.workArea,
      Object.values(layout.cards)
        .filter((c) => c.visible && c.displayId === display.id)
        .map((c) => c.bounds),
    );
    if (!bounds) throw new AppError("layer.quotaExceeded", "No free card position on this display");
    const instance = randomUUID(),
      id = "widget:" + instance;
    const stored: WidgetLayoutCard = {
      kind: "widget",
      pluginId,
      widgetDefinitionId: definitionId,
      widgetInstanceId: instance,
      displayId: display.id,
      workAreaAtSave: display.workArea,
      bounds,
      group: definition.group,
      inputMode: definition.interactive ? "interactive" : "passive",
      order: Object.keys(layout.cards).length,
      visible: true,
      restore: true,
      createdAt: Date.now(),
    };
    const candidates = [
      ...Object.entries(layout.cards).flatMap(([cardId, card]) => {
        if (
          card.kind !== "widget" ||
          !installed.some((p) => p.pluginId === card.pluginId && p.enabled && !p.lastError)
        )
          return [];
        const candidate = describe(card.pluginId).spark233.ui?.widgets?.[card.widgetDefinitionId];
        if (!candidate || (candidate.kind === "web" && !this.options.flags().webEnabled)) return [];
        return [{ id: cardId, card, renderKind: candidate.kind }];
      }),
      { id, card: stored, renderKind: definition.kind },
    ];
    if (this.allocate(candidates).suspended[id])
      throw new AppError("layer.quotaExceeded", "Desktop card quota exceeded");
    layout.cards[id] = stored;
    layout.revision++;
    await this.options.store.commit(layout, layout.revision - 1);
    await this.sync();
    return instance;
  }
  async remove(instance: string): Promise<void> {
    const record = this.records.get(instance);
    await this.options.store.removeWidget(instance);
    if (record) {
      for (const action of record.attachActions)
        try {
          await this.subscription(record, action, "remove");
        } catch (error) {
          this.diagnostic("widget.removePending", error);
        }
      this.drop(record);
    }
    this.options.layer.refresh();
  }
  async update(
    instance: string,
    patch: Partial<
      Pick<
        WidgetLayoutCard,
        | "visible"
        | "group"
        | "inputMode"
        | "bounds"
        | "displayId"
        | "edgeAutoHide"
        | "fullscreenAutoHide"
      >
    >,
  ): Promise<void> {
    const layout = this.options.store.load(),
      id = "widget:" + instance,
      old = layout.cards[id];
    if (!old || old.kind !== "widget")
      throw new AppError("widget.notDeclared", "Unknown widget instance");
    const definition = this.host().manager.describe(old.pluginId).spark233.ui?.widgets?.[
      old.widgetDefinitionId
    ];
    if (patch.inputMode === "interactive" && !definition?.interactive)
      throw new AppError("permissionDenied", "This widget only supports passive display");
    const displays = this.options.layer.options.displays();
    const display = displays.find((item) => item.id === (patch.displayId ?? old.displayId));
    if (patch.displayId && !display)
      throw new AppError("layer.displayUnavailable", "Target display is unavailable");
    layout.cards[id] = constrainLayerCard(
      {
        ...old,
        ...patch,
        ...(patch.bounds && display ? { workAreaAtSave: { ...display.workArea } } : {}),
      },
      displays,
      this.options.layer.options.primaryDisplay(),
    ).card as WidgetLayoutCard;
    layout.revision++;
    await this.options.store.commit(layout, layout.revision - 1);
    await this.sync();
  }
  async retry(instance: string): Promise<void> {
    const r = this.records.get(instance);
    if (
      !r ||
      !this.options.flags().enabled ||
      !r.stored.visible ||
      (r.status !== "fault" && !this.options.layer.surfaceFailure(r.id))
    )
      throw new AppError("widget.commandDenied", "This card is not available for retry");
    r.status = "active";
    r.reason = undefined;
    r.lastBeat = Date.now();
    r.providerFailures = 0;
    r.providerRetryAt = 0;
    this.options.layer.retryCard(r.id);
    this.options.layer.refresh();
  }
  async reloadAfterRestore(): Promise<void> {
    await this.queue.catch(() => {});
    for (const r of this.records.values()) this.drop(r);
    this.suspensions.clear();
    this.options.layer.refresh();
    await this.sync();
  }
  sync(): Promise<void> {
    const operation = this.queue.catch(() => {}).then(() => this.reconcile());
    this.queue = operation;
    return operation;
  }
  private async reconcile(): Promise<void> {
    if (this.disposed || !this.options.pluginHost()) return;
    const host = this.host(),
      layout = this.options.store.load();
    const installed = host.manager.list();
    const metadata = new Map<string, PluginPackageMetadata>();
    const describe = (id: string) => {
      let value = metadata.get(id);
      if (!value) {
        value = host.manager.describe(id);
        metadata.set(id, value);
      }
      return value;
    };
    let migrated = false;
    for (const [id, card] of Object.entries(layout.cards)) {
      if (card.kind !== "widget" || !installed.some((entry) => entry.pluginId === card.pluginId))
        continue;
      let definition: PluginWidget | undefined;
      try {
        definition = describe(card.pluginId).spark233.ui?.widgets?.[card.widgetDefinitionId];
      } catch {
        continue;
      }
      if (
        definition?.kind !== "declarative" ||
        !definition.desktopInteractions ||
        definition.resizable ||
        (card.bounds.width === definition.size.width &&
          card.bounds.height === definition.size.height)
      )
        continue;
      // Fixed template size updates preserve the user's stored input preference.
      // A narrower HUD must not silently turn click-through off.
      const area = card.workAreaAtSave;
      const bounds = { ...card.bounds, ...definition.size };
      // Keep the saved right/bottom attachment when a fixed template shrinks.
      // constrainLayerCard then maps that saved geometry to the current display.
      if (Math.abs(card.bounds.x + card.bounds.width - area.x - area.width) <= 8)
        bounds.x += card.bounds.width - bounds.width;
      if (Math.abs(card.bounds.y + card.bounds.height - area.y - area.height) <= 8)
        bounds.y += card.bounds.height - bounds.height;
      const normalized = constrainLayerCard(
        {
          ...card,
          bounds,
        },
        this.options.layer.options.displays(),
        this.options.layer.options.primaryDisplay(),
      ).card;
      // Tiny work areas can clamp a fixed template below its declared size;
      // never produce another migration revision for the same clamped result.
      if (JSON.stringify(normalized) === JSON.stringify(card)) continue;
      layout.cards[id] = normalized;
      migrated = true;
    }
    if (migrated) {
      const revision = layout.revision++;
      try {
        await this.options.store.commit(layout, revision);
      } catch (error) {
        // The winning writer publishes a new store event and queues sync.
        // Recompute from its durable layout rather than replacing user edits.
        if (error instanceof AppError && error.code === "layer.layoutConflict") return;
        throw error;
      }
    }
    const stored = Object.values(layout.cards)
      .filter((card): card is WidgetLayoutCard => card.kind === "widget")
      .map(
        (card) =>
          constrainLayerCard(
            card,
            this.options.layer.options.displays(),
            this.options.layer.options.primaryDisplay(),
          ).card,
      );
    const eligible = stored.flatMap((card) => {
      const installation = installed.find((p) => p.pluginId === card.pluginId);
      if (!card.visible || !installation?.enabled || installation.lastError) return [];
      try {
        const definition = describe(card.pluginId).spark233.ui?.widgets?.[card.widgetDefinitionId];
        if (!definition || (definition.kind === "web" && !this.options.flags().webEnabled))
          return [];
        return [{ id: "widget:" + card.widgetInstanceId, card, renderKind: definition.kind }];
      } catch {
        return [];
      }
    });
    const allocation = this.allocate(eligible);
    const active = new Set(allocation.active);
    this.suspensions = new Map(
      Object.entries(allocation.suspended).map(([id, reason]) => [id.slice(7), reason]),
    );
    // Eligibility freshly validated these packages in this reconciliation.
    // Recheck live ownership without re-reading every card's shared resources.
    for (const r of this.records.values())
      if (
        !active.has(r.id) ||
        !this.options.flags().enabled ||
        (r.definition.kind === "web" && !this.options.flags().webEnabled) ||
        !metadata.has(r.binding.pluginId) ||
        !host.manager.isOwnerCurrent(r.binding.owner, undefined, true)
      ) {
        const detach = r.providerAttached && host.manager.isOwnerCurrent(r.binding.owner);
        this.drop(r);
        if (detach)
          for (const action of r.attachActions)
            try {
              await this.subscription(r, action, "detach");
            } catch (error) {
              this.diagnostic("widget.detach", error);
            }
      }
    if (!this.options.flags().enabled) {
      this.options.layer.refresh();
      return;
    }
    for (const card of stored) {
      if (!active.has("widget:" + card.widgetInstanceId)) continue;
      const install = installed.find((p) => p.pluginId === card.pluginId);
      if (!install?.enabled || install.lastError) continue;
      let current = this.records.get(card.widgetInstanceId);
      if (current) {
        if (
          current.stored.displayId !== card.displayId ||
          current.stored.visible !== card.visible ||
          current.stored.edgeAutoHide !== card.edgeAutoHide ||
          current.stored.inputMode !== card.inputMode ||
          JSON.stringify(current.stored.bounds) !== JSON.stringify(card.bounds)
        ) {
          this.cancelEdgeMotion(current);
          if (current.interaction) current.interaction.edgeHidden = false;
        }
        current.stored = card;
        continue;
      }
      try {
        const definition = describe(card.pluginId).spark233.ui?.widgets?.[card.widgetDefinitionId];
        if (!definition || (definition.kind === "web" && !this.options.flags().webEnabled))
          continue;
        const owner = await host.manager.ensureWidgetOwner(card.pluginId);
        const latest = this.options.store.load().cards["widget:" + card.widgetInstanceId];
        if (
          this.disposed ||
          !this.options.flags().enabled ||
          (definition.kind === "web" && !this.options.flags().webEnabled) ||
          latest?.kind !== "widget" ||
          !latest.visible ||
          latest.pluginId !== card.pluginId ||
          latest.widgetDefinitionId !== card.widgetDefinitionId ||
          !host.manager.isOwnerCurrent(owner)
        )
          continue;
        const entry = host.widgetEntries(card.pluginId).widgets[card.widgetDefinitionId];
        if (!entry) continue;
        const values = Object.fromEntries(
          Object.entries(definition.data).map(([k, d]) => [
            k,
            d.source === "static" ? d.value : null,
          ]),
        ) as Record<string, WidgetValue>;
        const natives = Object.keys(host.widgetEntries(card.pluginId).native);
        current = {
          id: "widget:" + card.widgetInstanceId,
          stored: card,
          definition,
          entry,
          binding: {
            pluginId: card.pluginId,
            widgetDefinitionId: card.widgetDefinitionId,
            widgetInstanceId: card.widgetInstanceId,
            owner,
            loadGeneration: ++this.generation,
          },
          data: { revision: 0, at: Date.now(), values },
          values,
          ready: definition.kind !== "web",
          nonce: randomBytes(16).toString("hex"),
          hostname: "widget-" + randomUUID(),
          seq: 0,
          incoming: 0,
          lastBeat: Date.now(),
          lastSent: 0,
          status: "active",
          pending: new Map(),
          lastInvoke: 0,
          attachActions: new Set(),
          receiveWindow: Date.now(),
          receiveCount: 0,
          providerAttached: false,
          providerFailures: 0,
          providerRetryAt: 0,
          nativeEntry:
            natives.length === 1 ? natives[0] : natives.includes("main") ? "main" : undefined,
          images:
            entry.kind === "declarative"
              ? Object.fromEntries(
                  Object.entries(entry.resources).map(([id, file]) => [
                    id,
                    "data:image/png;base64," + fs.readFileSync(file).toString("base64"),
                  ]),
                )
              : undefined,
          interaction:
            definition.kind === "declarative" && definition.desktopInteractions
              ? { preview: false, edgeHidden: false, menuOpen: false }
              : undefined,
        };
        this.records.set(card.widgetInstanceId, current);
        const record = current;
        record.release = host.subscribeWidgetEvents(owner, (event) => this.source(record, event));
        for (const d of Object.values(definition.data))
          if (d.source === "backend" || d.source === "native")
            record.attachActions.add(d.subscriptionAction);
      } catch (error) {
        this.diagnostic("widget.restore", error);
      }
    }
    this.options.layer.refresh();
  }
  private cards(): LayerCard[] {
    const records = [...this.records.values()];
    // Notes geometry can change synchronously before queued reconciliation
    // detaches over-budget widgets. Enforce the same quota in that first frame.
    const active = new Set(
      this.allocate(
        records.map((r) => ({
          id: r.id,
          card: r.stored,
          renderKind: r.definition.kind,
        })),
      ).active,
    );
    return records
      .filter(
        (r) =>
          active.has(r.id) &&
          r.status !== "suspended" &&
          // Display-only polling still checks the live owner and scope each
          // time; package execution is freshly validated at its own boundary.
          this.host().manager.isOwnerCurrent(r.binding.owner, undefined, true),
      )
      .flatMap((r): LayerCard[] => {
        const interactions =
          r.definition.kind === "declarative" ? r.definition.desktopInteractions : undefined;
        const intrinsicHeight = r.definition.kind === "declarative" && !!r.definition.contentHeight;
        const bounds = r.interaction?.bounds ? this.contentBounds(r) : this.presentedBounds(r);
        const main = {
          id: r.id,
          consumerId: "widgets",
          widget: r.binding,
          renderKind: r.definition.kind,
          renderRef: r.stored.widgetDefinitionId,
          ...r.stored,
          bounds,
          transientGeometry: !!interactions || intrinsicHeight,
          desktopInteractive: !!interactions,
          intrinsicHeight,
          presentationHidden: !!r.interaction?.bounds,
          fullscreenAutoHide: r.stored.fullscreenAutoHide ?? interactions?.fullscreenAutoHide,
          template: r.entry.kind === "declarative" ? r.entry.template : undefined,
          hover:
            r.entry.kind === "declarative" && r.entry.hoverTemplate && interactions?.hover
              ? { template: r.entry.hoverTemplate, size: interactions.hover.size }
              : undefined,
          data: r.data,
          title: r.definition.title,
          status: r.status,
          reason: r.reason,
          images: r.images,
        };
        if (r.interaction?.bounds) {
          const moving = r.interaction.bounds;
          return [
            main,
            ...this.options.layer.options
              .displays()
              .filter((display) => intersectRect(moving, display.workArea))
              .map((display) => ({
                ...main,
                id: r.id + ":drag:" + display.id,
                bounds: moving,
                displayId: display.id,
                // Keep the source display's already loaded capture surface.
                // Switching it to passive cold-starts another renderer on every drag.
                inputMode: display.id === r.stored.displayId ? r.stored.inputMode : "passive",
                desktopInteractive: false,
                presentationHidden: false,
                presentationOnly: true,
                order: 1_000_000 + r.stored.order,
              })),
          ];
        }
        const hover = interactions?.hover;
        if (
          !r.interaction?.preview ||
          !hover ||
          r.entry.kind !== "declarative" ||
          !r.entry.hoverTemplate ||
          this.options.layer.snapshot().editing
        )
          return [main];
        return [
          main,
          {
            ...main,
            id: r.id + ":hover",
            bounds: this.previewBounds(r),
            template: r.entry.hoverTemplate,
            presentationOnly: true,
            intrinsicHeight: true,
            order: 1_000_000 + r.stored.order,
          } as LayerCard,
        ];
      });
  }
  private interactionDefinition(r: RuntimeCard) {
    return r.definition.kind === "declarative" ? r.definition.desktopInteractions : undefined;
  }
  private contentBounds(r: RuntimeCard): Rect {
    const bounds = r.stored.bounds;
    if (r.contentHeight === undefined) return bounds;
    const area =
      this.options.layer.options.displays().find((d) => d.id === r.stored.displayId)?.workArea ??
      r.stored.workAreaAtSave;
    const height = Math.min(r.contentHeight, area.height);
    // Preserve a bottom attachment while measuring; the saved fallback size is
    // unchanged, so polling and font loading never write desktop layout files.
    const y =
      Math.abs(bounds.y + bounds.height - area.y - area.height) <= 8
        ? bounds.y + bounds.height - height
        : bounds.y;
    return { ...bounds, y: Math.max(area.y, Math.min(y, area.y + area.height - height)), height };
  }
  private edge(r: RuntimeCard): "left" | "right" | "top" | "bottom" | undefined {
    if (!(r.stored.edgeAutoHide ?? this.interactionDefinition(r)?.edgeAutoHide)) return;
    const area = this.options.layer.options
      .displays()
      .find((d) => d.id === r.stored.displayId)?.workArea;
    if (!area) return;
    const bounds = this.contentBounds(r);
    const edges = [
      ["left", Math.abs(bounds.x - area.x)],
      ["right", Math.abs(bounds.x + bounds.width - area.x - area.width)],
      ["top", Math.abs(bounds.y - area.y)],
      ["bottom", Math.abs(bounds.y + bounds.height - area.y - area.height)],
    ] as const;
    return [...edges].sort((a, b) => a[1] - b[1]).find((entry) => entry[1] <= 8)?.[0];
  }
  private presentedBounds(r: RuntimeCard): Rect {
    return r.interaction?.bounds ?? r.interaction?.edgeBounds ?? this.edgeTargetBounds(r);
  }
  private edgeTargetBounds(r: RuntimeCard): Rect {
    const bounds = r.interaction?.bounds ?? this.contentBounds(r);
    if (!r.interaction?.edgeHidden) return bounds;
    const edge = this.edge(r);
    const area = this.options.layer.options
      .displays()
      .find((d) => d.id === r.stored.displayId)?.workArea;
    if (!edge || !area) return bounds;
    const strip = 4;
    return {
      ...bounds,
      ...(edge === "left"
        ? { x: area.x - bounds.width + strip }
        : edge === "right"
          ? { x: area.x + area.width - strip }
          : edge === "top"
            ? { y: area.y - bounds.height + strip }
            : { y: area.y + area.height - strip }),
    };
  }
  private cancelEdgeMotion(r: RuntimeCard): void {
    if (r.interaction) {
      r.interaction.edgeBounds = undefined;
      r.interaction.edgeMotion = undefined;
    }
    if (
      this.edgeFrame &&
      ![...this.records.values()].some((record) => record.interaction?.edgeMotion)
    ) {
      clearTimeout(this.edgeFrame);
      this.edgeFrame = undefined;
    }
  }
  private setEdgeHidden(r: RuntimeCard, hidden: boolean): void {
    const state = r.interaction;
    if (!state || state.edgeHidden === hidden) return;
    const from = { ...this.presentedBounds(r) };
    this.cancelEdgeMotion(r);
    state.edgeHidden = hidden;
    const to = this.edgeTargetBounds(r);
    const settings = systemPreferences.getAnimationSettings();
    if (
      !settings.prefersReducedMotion &&
      settings.shouldRenderRichAnimation &&
      (from.x !== to.x || from.y !== to.y)
    ) {
      state.edgeBounds = from;
      state.edgeMotion = { from, to, startedAt: performance.now() };
      this.scheduleEdgeFrame();
    }
    this.options.layer.refresh();
  }
  private scheduleEdgeFrame(): void {
    if (this.disposed || this.edgeFrame) return;
    // Reuse the existing 180 ms cubic ease-out from window controls. Shared
    // cards need host frames so native shape and renderer geometry move together.
    // The scheduler exists only for an active transition, never while idle.
    this.edgeFrame = setTimeout(() => {
      this.edgeFrame = undefined;
      const now = performance.now();
      let changed = false;
      let active = false;
      for (const r of this.records.values()) {
        const state = r.interaction;
        const motion = state?.edgeMotion;
        if (!state || !motion) continue;
        const progress = Math.min(1, (now - motion.startedAt) / 180);
        const eased = 1 - Math.pow(1 - progress, 3);
        const next = {
          ...motion.to,
          x: Math.round(motion.from.x + (motion.to.x - motion.from.x) * eased),
          y: Math.round(motion.from.y + (motion.to.y - motion.from.y) * eased),
        };
        changed ||= state.edgeBounds?.x !== next.x || state.edgeBounds?.y !== next.y;
        if (progress === 1) {
          state.edgeBounds = undefined;
          state.edgeMotion = undefined;
        } else {
          state.edgeBounds = next;
          active = true;
        }
      }
      if (changed) this.options.layer.refresh();
      if (active) this.scheduleEdgeFrame();
    }, 16);
    this.edgeFrame.unref();
  }
  private previewBounds(r: RuntimeCard): Rect {
    const size = this.interactionDefinition(r)!.hover!.size;
    const area =
      this.options.layer.options.displays().find((d) => d.id === r.stored.displayId)?.workArea ??
      r.stored.workAreaAtSave;
    const bar = this.contentBounds(r);
    const width = Math.min(size.width, area.width),
      height = Math.min(r.interaction?.previewHeight ?? size.height, size.height, area.height);
    const preferredY = bar.y - height - 6 >= area.y ? bar.y - height - 6 : bar.y + bar.height + 6;
    return {
      x: Math.max(area.x, Math.min(area.x + area.width - width, bar.x + bar.width - width)),
      y: Math.max(area.y, Math.min(area.y + area.height - height, preferredY)),
      width,
      height,
    };
  }
  private cancelInteractions(): void {
    this.drag = undefined;
    if (this.edgeFrame) clearTimeout(this.edgeFrame);
    this.edgeFrame = undefined;
    let changed = false;
    for (const r of this.records.values()) {
      const state = r.interaction;
      if (!state) continue;
      changed ||= state.preview || !!state.bounds || state.edgeHidden || !!state.edgeBounds;
      state.menu?.closePopup();
      state.menu = undefined;
      state.menuOpen = false;
      state.bounds = undefined;
      state.pointerTarget = undefined;
      state.preview = false;
      state.edgeHidden = false;
      state.edgeBounds = undefined;
      state.edgeMotion = undefined;
      state.hoverAt = undefined;
      state.leaveAt = undefined;
    }
    if (changed) this.options.layer.refresh();
  }
  private tickInteraction(r: RuntimeCard, now: number): void {
    const state = r.interaction,
      config = this.interactionDefinition(r);
    if (!state || !config) return;
    if (state.menuOpen || this.drag?.record === r) return;
    if (!this.options.layer.isCardVisible(r.id)) {
      if (state.preview || state.edgeHidden || state.edgeMotion) {
        this.cancelEdgeMotion(r);
        state.preview = state.edgeHidden = false;
        this.options.layer.refresh();
      }
      state.hoverAt = state.leaveAt = undefined;
      return;
    }
    const cursor = this.options.layer.options.cursor?.();
    if (!cursor) return;
    const workArea = this.options.layer.options
      .displays()
      .find((d) => d.id === r.stored.displayId)?.workArea;
    // Native pointer entry arms hover. Coordinates alone must not open a
    // preview when an ordinary window covers this non-topmost card.
    const overBar =
      state.pointerTarget === r.id &&
      contains(this.presentedBounds(r), cursor) &&
      (!workArea || contains(workArea, cursor));
    const overPreview =
      state.pointerTarget === r.id + ":hover" &&
      state.preview &&
      contains(this.previewBounds(r), cursor);
    if (overBar || overPreview) {
      state.leaveAt = undefined;
      state.hoverAt ??= now;
      if (state.edgeHidden) {
        state.hoverAt = now;
        this.setEdgeHidden(r, false);
      } else if (config.hover && !state.preview && now - state.hoverAt >= 250) {
        state.preview = true;
        this.options.layer.refresh();
      }
      return;
    }
    state.hoverAt = undefined;
    state.leaveAt ??= now;
    if (state.preview && now - state.leaveAt >= 250) {
      state.preview = false;
      this.options.layer.refresh();
    }
    if (!state.edgeHidden && this.edge(r) && now - state.leaveAt >= 600) {
      this.setEdgeHidden(r, true);
    }
  }
  private async pointer(event: LayerPointerEvent): Promise<void> {
    const r = [...this.records.values()].find(
      (card) => event.cardId === card.id || event.cardId === card.id + ":hover",
    );
    if (
      !r?.interaction ||
      !this.interactionDefinition(r) ||
      r.status !== "active" ||
      // Pointer motion only changes host presentation. Keep the live owner fence
      // here; command/menu dispatch performs fresh package validation separately.
      !this.host().manager.isOwnerCurrent(r.binding.owner, undefined, event.type !== "contextmenu")
    )
      return;
    const state = r.interaction;
    if (event.type === "enter") {
      state.pointerTarget = event.cardId;
      if (event.cardId === r.id && state.edgeHidden) {
        state.hoverAt = Date.now();
        this.setEdgeHidden(r, false);
      }
    }
    if (event.type === "leave" && state.pointerTarget === event.cardId)
      state.pointerTarget = undefined;
    if (event.type === "contextmenu") {
      this.cancelEdgeMotion(r);
      this.drag = undefined;
      state.bounds = undefined;
      return this.contextMenu(r);
    }
    if (event.cardId !== r.id) return;
    if (event.type === "cancel") {
      // Releasing capture after up can deliver cancel while the durable move is
      // still pending. The accepted up owns that handoff until sync completes.
      if (this.drag?.record === r && !this.drag.committing) this.cancelInteractions();
      return;
    }
    if (event.type === "down" && event.button === "left" && !state.menuOpen) {
      if (this.drag?.committing) return;
      const origin = { ...this.presentedBounds(r) };
      this.cancelEdgeMotion(r);
      state.preview = state.edgeHidden = false;
      state.bounds =
        origin.x !== r.stored.bounds.x || origin.y !== r.stored.bounds.y ? origin : undefined;
      state.hoverAt = state.leaveAt = undefined;
      this.drag = {
        record: r,
        pointerId: event.pointerId,
        origin,
        // DesktopLayer validated this local hit and converted it to native DIPs.
        // Sampling the cursor here anchors to a later point when dispatch is busy.
        start: { x: event.screenX, y: event.screenY },
        moved: false,
      };
      this.options.layer.refresh();
      return;
    }
    const drag = this.drag;
    if (
      !drag ||
      drag.committing ||
      drag.record !== r ||
      drag.pointerId !== event.pointerId ||
      (event.type !== "move" && event.type !== "up")
    )
      return;
    const cursor = this.options.layer.options.cursor?.();
    if (!cursor) return;
    const dx = cursor.x - drag.start.x,
      dy = cursor.y - drag.start.y;
    drag.moved ||= Math.hypot(dx, dy) >= 4;
    if (event.type === "move") {
      if (drag.moved) {
        state.bounds = { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy };
        this.options.layer.refresh();
      }
      return;
    }
    state.hoverAt = state.leaveAt = undefined;
    if (!drag.moved) {
      this.drag = undefined;
      state.bounds = undefined;
      this.options.layer.refresh();
      await this.invoke(r.id, this.interactionDefinition(r)!.primaryAction, undefined, true);
      return;
    }
    const bounds = { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy };
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const displays = this.options.layer.options.displays();
    const distance = (area: Rect) =>
      Math.hypot(
        center.x - Math.max(area.x, Math.min(area.x + area.width, center.x)),
        center.y - Math.max(area.y, Math.min(area.y + area.height, center.y)),
      );
    const display = [...displays].sort((a, b) => distance(a.workArea) - distance(b.workArea))[0];
    if (display && (r.stored.edgeAutoHide ?? this.interactionDefinition(r)?.edgeAutoHide)) {
      const area = display.workArea;
      if (Math.abs(bounds.x - area.x) <= 12) bounds.x = area.x;
      else if (Math.abs(bounds.x + bounds.width - area.x - area.width) <= 12)
        bounds.x = area.x + area.width - bounds.width;
      if (Math.abs(bounds.y - area.y) <= 12) bounds.y = area.y;
      else if (Math.abs(bounds.y + bounds.height - area.y - area.height) <= 12)
        bounds.y = area.y + area.height - bounds.height;
    }
    drag.committing = true;
    state.bounds = bounds;
    this.options.layer.refresh();
    try {
      await this.update(r.stored.widgetInstanceId, {
        bounds,
        ...(display ? { displayId: display.id } : {}),
      });
    } finally {
      if (this.drag === drag) {
        this.drag = undefined;
        state.bounds = undefined;
        this.options.layer.refresh();
      }
    }
  }
  private contextMenu(r: RuntimeCard): void {
    const state = r.interaction!,
      config = this.interactionDefinition(r)!;
    if (!config.menu || state.menuOpen) return;
    state.menuOpen = true;
    state.preview = state.edgeHidden = false;
    state.hoverAt = state.leaveAt = undefined;
    this.options.layer.refresh();
    const zh = this.options.locale().startsWith("zh");
    const current = () =>
      this.records.get(r.stored.widgetInstanceId) === r &&
      r.status === "active" &&
      r.stored.visible &&
      this.host().manager.isOwnerCurrent(r.binding.owner);
    const update = (patch: Parameters<WidgetHost["update"]>[1]) => {
      if (current())
        void this.update(r.stored.widgetInstanceId, patch).catch((error) =>
          this.diagnostic("widget.desktopMenu", error),
        );
    };
    const menu: MenuItemConstructorOptions[] = [
      {
        label: zh ? "窗口置顶显示" : "Always on top",
        type: "checkbox",
        checked: r.stored.group === "top",
        click: (item) => update({ group: item.checked ? "top" : "normal" }),
      },
      {
        label: zh ? "贴边自动隐藏" : "Auto-hide at screen edge",
        type: "checkbox",
        checked: r.stored.edgeAutoHide ?? config.edgeAutoHide,
        click: (item) => update({ edgeAutoHide: item.checked }),
      },
      {
        label: zh ? "全屏时自动隐藏" : "Hide in fullscreen",
        type: "checkbox",
        checked: r.stored.fullscreenAutoHide ?? config.fullscreenAutoHide,
        click: (item) => update({ fullscreenAutoHide: item.checked }),
      },
      { type: "separator" },
      {
        label: config.menu.openLabel,
        click: () => {
          if (current())
            void this.invoke(r.id, config.primaryAction, undefined, true).catch((error) =>
              this.diagnostic("widget.desktopMenu", error),
            );
        },
      },
      { label: config.menu.hideLabel, click: () => update({ visible: false }) },
    ];
    state.menu = Menu.buildFromTemplate(menu);
    state.menu.popup({
      callback: () => {
        state.menu = undefined;
        state.menuOpen = false;
        state.hoverAt = undefined;
        state.leaveAt = Date.now();
      },
    });
  }
  private acceptIcons(r: RuntimeCard, value: unknown): void {
    try {
      if (!r.interaction || !value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid widget icons");
      const entries = Object.entries(value);
      if (entries.length > 6) throw new Error("Widget icon count exceeded");
      const images: Record<string, string> = {};
      let total = 0;
      for (const [id, encoded] of entries) {
        if (
          !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id) ||
          id.length > 80 ||
          ["constructor", "prototype", "__proto__"].includes(id) ||
          (r.entry.kind === "declarative" && Object.hasOwn(r.entry.resources, id)) ||
          typeof encoded !== "string" ||
          encoded.length > 87384 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
        )
          throw new Error("Invalid widget icon handle");
        const png = Buffer.from(encoded, "base64");
        total += png.length;
        if (
          png.toString("base64") !== encoded ||
          png.length < 24 ||
          png.length > 64 * 1024 ||
          total > 256 * 1024 ||
          !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          png.readUInt32BE(16) < 1 ||
          png.readUInt32BE(20) < 1 ||
          png.readUInt32BE(16) > 256 ||
          png.readUInt32BE(20) > 256
        )
          throw new Error("Widget PNG exceeds bounds");
        images[id] = "data:image/png;base64," + encoded;
      }
      const resources = r.entry.kind === "declarative" ? r.entry.resources : {};
      const staticImages = Object.fromEntries(
        Object.entries(r.images ?? {}).filter(([id]) => Object.hasOwn(resources, id)),
      );
      const next = { ...staticImages, ...images };
      if (JSON.stringify(next) !== JSON.stringify(r.images)) {
        r.images = next;
        this.options.layer.refresh();
      }
    } catch (error) {
      this.diagnostic("widget.invalidIcons", error);
    }
  }
  private source(r: RuntimeCard, event: SourceEvent): void {
    if (
      this.records.get(r.stored.widgetInstanceId) !== r ||
      r.status !== "active" ||
      !r.providerAttached ||
      !this.options.layer.isCardVisible(r.id) ||
      !samePluginOwner(event.owner, r.binding.owner) ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload) ||
      event.payload.widgetInstanceId !== r.stored.widgetInstanceId
    )
      return;
    const raw = event.payload.values;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const values: Record<string, WidgetValue> = { ...r.values };
    for (const [key, d] of Object.entries(r.definition.data))
      if (
        (d.source === "backend" || d.source === "native") &&
        d.source === event.source &&
        d.event === event.name &&
        (d.source !== "native" || (d.entryId ?? r.nativeEntry) === event.entryId) &&
        Object.hasOwn(raw, key)
      )
        values[key] = raw[key] as WidgetValue;
    this.acceptValues(r, values);
    const icons = event.payload.icons;
    if (icons !== undefined) this.acceptIcons(r, icons);
  }
  private acceptValues(r: RuntimeCard, values: unknown): void {
    try {
      const frame = parseWidgetData(
        { revision: r.data.revision + 1, at: Date.now(), values },
        r.definition,
      );
      r.values = { ...frame.values };
      r.data = frame;
    } catch (error) {
      this.diagnostic("widget.invalidData", error);
    }
  }
  private tick(): void {
    if (this.disposed) return;
    const now = Date.now();
    const locale = this.options.locale();
    if (now - this.clockSample.at >= 1000 || this.clockSample.locale !== locale)
      this.clockSample = {
        at: now,
        locale,
        text: new Date(now).toLocaleTimeString(locale, { hour12: false }),
      };
    this.tokens = Math.min(50 * 1024, this.tokens + ((now - this.tokenAt) * 50 * 1024) / 1000);
    this.tokenAt = now;
    const records = [...this.records.values()];
    const offset = records.length ? this.nextRecord++ % records.length : 0;
    for (let index = 0; index < records.length; index++) {
      const r = records[(index + offset) % records.length];
      this.tickInteraction(r, now);
      if (
        r.status !== "active" ||
        !this.host().manager.isOwnerCurrent(r.binding.owner, undefined, true) ||
        !r.stored.visible
      ) {
        this.environment(r, false);
        this.providers(r, false);
        continue;
      }
      const visible = this.options.layer.isCardVisible(r.id);
      this.environment(r, visible);
      this.providers(r, visible);
      if (!visible) {
        r.lastBeat = now;
        if (r.handshakeAt) r.handshakeAt = now;
        continue;
      }
      if (
        r.definition.kind === "web" &&
        r.surfaceId &&
        ((!r.ready && r.handshakeAt && now - r.handshakeAt > 5000) ||
          (r.ready && now - r.lastBeat > 7000))
      ) {
        r.status = "fault";
        r.reason = r.ready ? "Widget stopped responding" : "Widget did not become ready";
        for (const pending of r.pending.values()) pending.abort();
        r.pending.clear();
        this.providers(r, false);
        this.options.layer.recoverCard(r.id, "widget.heartbeatTimeout", new Error(r.reason));
        continue;
      }
      if (!r.ready || now - r.lastSent < r.definition.refreshMs) continue;
      const values = { ...r.values };
      for (const [key, d] of Object.entries(r.definition.data))
        if (d.source === "host")
          values[key] = d.format === "text" ? this.clockSample.text : this.clockSample.at;
      this.acceptValues(r, values);
      const bytes = Buffer.byteLength(JSON.stringify(r.data));
      const old = this.pluginTokens.get(r.binding.pluginId) ?? { tokens: 16 * 1024, at: now };
      old.tokens = Math.min(16 * 1024, old.tokens + ((now - old.at) * 16 * 1024) / 1000);
      old.at = now;
      this.pluginTokens.set(r.binding.pluginId, old);
      if (bytes > this.tokens || bytes > old.tokens) continue;
      this.tokens -= bytes;
      old.tokens -= bytes;
      r.lastSent = now;
      if (r.definition.kind === "web") {
        if (r.ready && r.surfaceId) this.wire(r, "data", r.data as unknown as JsonValue);
      } else {
        this.options.layer.publishData(r.id, r.data);
        if (r.interaction?.preview) this.options.layer.publishData(r.id + ":hover", r.data);
        if (r.interaction?.bounds)
          for (const display of this.options.layer.options.displays())
            this.options.layer.publishData(r.id + ":drag:" + display.id, r.data);
      }
    }
  }
  private environment(r: RuntimeCard, visible: boolean): void {
    if (r.definition.kind !== "web" || !r.ready) return;
    const card = this.options.layer.card(r.id);
    const display = this.options.layer.options.displays().find((d) => d.id === card?.displayId);
    const next = {
      theme: this.options.theme(),
      locale: this.options.locale(),
      scaleFactor: display?.scaleFactor ?? 1,
      width: Math.round(card?.bounds.width ?? r.stored.bounds.width),
      height: Math.round(card?.bounds.height ?? r.stored.bounds.height),
      visible,
    };
    const old = r.environment;
    if (
      !old ||
      old.theme !== next.theme ||
      old.locale !== next.locale ||
      old.scaleFactor !== next.scaleFactor
    )
      this.wire(r, "theme", {
        theme: next.theme,
        locale: next.locale,
        scaleFactor: next.scaleFactor,
      });
    if (!old || old.width !== next.width || old.height !== next.height)
      this.wire(r, "size", { width: next.width, height: next.height });
    if (!old || old.visible !== visible) {
      this.wire(r, "visibility", { visible });
      if (!visible) for (const pending of r.pending.values()) pending.abort();
      else r.lastSent = 0;
    }
    r.environment = next;
  }
  private providers(r: RuntimeCard, visible: boolean): void {
    if (
      r.providerTransition ||
      (r.providerAttached === visible && !(visible && r.providerFailures > 0))
    )
      return;
    if (visible && Date.now() < r.providerRetryAt) return;
    r.providerAttached = visible;
    if (!r.attachActions.size) return;
    const binding = structuredClone(r.binding);
    r.providerTransition = (async () => {
      for (const action of r.attachActions) {
        if (
          this.records.get(r.stored.widgetInstanceId) !== r ||
          !sameWidgetBinding(r.binding, binding) ||
          (visible && !this.options.layer.isCardVisible(r.id))
        )
          return;
        try {
          const first = await this.subscription(r, action, visible ? "attach" : "detach");
          if (
            visible &&
            this.records.get(r.stored.widgetInstanceId) === r &&
            sameWidgetBinding(r.binding, binding) &&
            this.options.layer.isCardVisible(r.id) &&
            first &&
            typeof first === "object" &&
            !Array.isArray(first) &&
            "values" in first
          ) {
            const raw = first.values;
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
              const values = { ...r.values };
              for (const [key, source] of Object.entries(r.definition.data))
                if (
                  (source.source === "backend" || source.source === "native") &&
                  source.subscriptionAction === action &&
                  Object.hasOwn(raw, key)
                )
                  values[key] = raw[key] as WidgetValue;
              this.acceptValues(r, values);
            }
            r.lastSent = 0;
          }
        } catch (error) {
          this.diagnostic("widget.sourceUnavailable", error);
          if (
            visible &&
            this.records.get(r.stored.widgetInstanceId) === r &&
            sameWidgetBinding(r.binding, binding) &&
            this.options.layer.isCardVisible(r.id)
          ) {
            r.providerAttached = true;
            r.providerFailures++;
            r.providerRetryAt = Date.now() + ([1000, 3000, 10000][r.providerFailures - 1] ?? 0);
            r.reason = "Data source is unavailable; retry this card";
            if (r.providerFailures > 3) {
              r.status = "fault";
              this.options.layer.refresh();
            }
            return;
          }
        }
      }
      if (
        visible &&
        this.records.get(r.stored.widgetInstanceId) === r &&
        sameWidgetBinding(r.binding, binding) &&
        this.options.layer.isCardVisible(r.id)
      ) {
        r.providerFailures = 0;
        r.providerRetryAt = 0;
        r.reason = undefined;
      }
    })().finally(() => {
      r.providerTransition = undefined;
    });
  }
  private async subscription(
    r: RuntimeCard,
    actionId: string,
    operation: "attach" | "detach" | "remove",
  ): Promise<JsonValue | undefined> {
    const action = r.definition.actions[actionId];
    if (!action || action.mode !== "query") return;
    const controller = new AbortController(),
      request = randomUUID(),
      timer = setTimeout(() => controller.abort(), 10000);
    r.pending.set(request, controller);
    try {
      return (
        await this.host().manager.executeWidgetOwned({
          binding: r.binding,
          actionId,
          origin: "subscription",
          mode: "query",
          commandId: action.commandId,
          input: { operation, widgetDefinitionId: r.stored.widgetDefinitionId },
          signal: controller.signal,
        })
      ).value;
    } finally {
      clearTimeout(timer);
      r.pending.delete(request);
    }
  }
  async invoke(
    id: string,
    actionId: string,
    input: JsonValue | undefined,
    userGesture = false,
    requestId?: string,
  ): Promise<unknown> {
    const r = [...this.records.values()].find((value) => value.id === id);
    if (
      !r ||
      r.status !== "active" ||
      r.stored.inputMode !== "interactive" ||
      !r.definition.interactive ||
      !this.options.layer.isCardVisible(id) ||
      this.options.layer.snapshot().editing
    )
      throw new AppError("widget.commandDenied", "Widget action is unavailable");
    const action = r.definition.actions[actionId];
    if (!action) throw new AppError("widget.commandDenied", "Unknown widget action");
    if (
      Buffer.byteLength(JSON.stringify(input ?? null)) > 4096 ||
      r.pending.size >= 4 ||
      Date.now() - r.lastInvoke < 500
    )
      throw new AppError("widget.rateLimited", "Widget action budget exceeded");
    r.lastInvoke = Date.now();
    if (action.mode === "open-main") {
      const captured = structuredClone(r.binding);
      if (!userGesture)
        throw new AppError(
          "widget.commandDenied",
          "Use the trusted host card button to open the main window",
        );
      return this.host().manager.activateOwned(
        r.binding.pluginId,
        {
          commandId: action.commandId,
          parameters: { widgetInstanceId: r.stored.widgetInstanceId, input: input ?? null },
        },
        () => {
          if (
            this.records.get(r.stored.widgetInstanceId) !== r ||
            !sameWidgetBinding(r.binding, captured) ||
            !r.stored.visible ||
            r.stored.inputMode !== "interactive" ||
            r.status !== "active" ||
            !this.options.layer.isCardVisible(r.id) ||
            !this.host().manager.isOwnerCurrent(captured.owner)
          )
            throw new Error("Widget owner expired");
        },
      );
    }
    const controller = new AbortController(),
      request = requestId ?? randomUUID();
    if (r.pending.has(request)) throw new Error("Duplicate widget request");
    r.pending.set(request, controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      return (
        await this.host().manager.executeWidgetOwned({
          binding: r.binding,
          actionId,
          origin: "widget",
          mode: action.mode,
          commandId: action.commandId,
          input,
          signal: controller.signal,
        })
      ).value;
    } finally {
      clearTimeout(timer);
      r.pending.delete(request);
    }
  }
  async lifecycle(owner: PluginOwner, phase: "quiesce" | "resume" | "revoke"): Promise<void> {
    for (const r of this.records.values())
      if (samePluginOwner(owner, r.binding.owner)) {
        if (phase === "quiesce") {
          this.cancelEdgeMotion(r);
          r.status = "suspended";
          for (const c of r.pending.values()) c.abort();
          r.pending.clear();
          r.ready = false;
        } else this.drop(r);
      }
    this.options.layer.refresh();
    if (phase === "resume") await this.sync();
  }
  private drop(r: RuntimeCard): void {
    if (this.records.get(r.stored.widgetInstanceId) !== r) return;
    r.interaction?.menu?.closePopup();
    this.cancelEdgeMotion(r);
    if (this.drag?.record === r) this.drag = undefined;
    r.release?.();
    for (const c of r.pending.values()) c.abort();
    r.pending.clear();
    this.records.delete(r.stored.widgetInstanceId);
  }
  private readySurface(surface: string, id: string): void {
    const r = [...this.records.values()].find((value) => value.id === id);
    if (!r) return;
    r.surfaceId = surface;
    r.ready = false;
    r.incoming = 0;
    r.seq = 0;
    r.lastBeat = Date.now();
    r.handshakeAt = Date.now();
    r.environment = undefined;
    const display = this.options.layer.options.displays().find((d) => d.id === r.stored.displayId);
    const init: WidgetInit = {
      binding: r.binding,
      locale: this.options.locale(),
      theme: this.options.theme(),
      scaleFactor: display?.scaleFactor ?? 1,
      size: { width: r.stored.bounds.width, height: r.stored.bounds.height },
      interactive: r.stored.inputMode === "interactive",
      actions: Object.fromEntries(
        Object.entries(r.definition.actions).map(([k, a]) => [k, { mode: a.mode }]),
      ),
      dataKeys: Object.keys(r.definition.data),
    };
    const { binding: _binding, ...initialPayload } = init;
    const initialWire = this.envelope(r, "init", initialPayload as unknown as JsonValue);
    this.options.layer.send(surface, {
      type: "widget-init",
      binding: r.binding,
      url: this.widgetURL(r),
      nonce: r.nonce,
      init,
      initialWire,
    });
  }
  private envelope(
    r: RuntimeCard,
    type: WidgetEnvelope["type"],
    payload?: JsonValue,
    requestId?: string,
  ): string {
    return JSON.stringify({
      protocol: 1,
      widgetDefinitionId: r.binding.widgetDefinitionId,
      widgetInstanceId: r.binding.widgetInstanceId,
      owner: r.binding.owner,
      loadGeneration: r.binding.loadGeneration,
      seq: ++r.seq,
      type,
      ...(payload === undefined ? {} : { payload }),
      ...(requestId ? { requestId } : {}),
    });
  }
  private wire(
    r: RuntimeCard,
    type: WidgetEnvelope["type"],
    payload?: JsonValue,
    requestId?: string,
  ): void {
    if (r.surfaceId)
      this.options.layer.send(r.surfaceId, {
        type: "widget-wire",
        wire: this.envelope(r, type, payload, requestId),
      });
  }
  async acceptWire(surface: string, binding: unknown, wire: string): Promise<void> {
    if (typeof wire !== "string" || Buffer.byteLength(wire) > 16384)
      throw new AppError("widget.protocolError", "Invalid widget message");
    const bindingInput = binding as WidgetBinding;
    const r = [...this.records.values()].find((value) => value.surfaceId === surface);
    if (
      !r ||
      !bindingInput ||
      bindingInput.widgetInstanceId !== r.binding.widgetInstanceId ||
      bindingInput.widgetDefinitionId !== r.binding.widgetDefinitionId ||
      bindingInput.loadGeneration !== r.binding.loadGeneration ||
      !bindingInput.owner ||
      !samePluginOwner(bindingInput.owner, r.binding.owner) ||
      !this.host().manager.isOwnerCurrent(r.binding.owner)
    )
      throw new AppError("widget.staleBinding", "Widget binding expired");
    const msg = parseWidgetEnvelope(wire, r.binding);
    const receivedBinding = structuredClone(r.binding);
    const replyCurrent = () =>
      this.records.get(r.stored.widgetInstanceId) === r &&
      r.surfaceId === surface &&
      sameWidgetBinding(r.binding, receivedBinding) &&
      this.host().manager.isOwnerCurrent(receivedBinding.owner);
    if (msg.seq <= r.incoming) return;
    r.incoming = msg.seq;
    if (Date.now() - r.receiveWindow >= 1000) {
      r.receiveWindow = Date.now();
      r.receiveCount = 0;
    }
    if (++r.receiveCount > 20)
      throw new AppError("widget.rateLimited", "Widget message rate exceeded");
    if (msg.type === "ready") {
      r.ready = true;
      r.lastBeat = Date.now();
      this.wire(r, "data", r.data as unknown as JsonValue);
      this.environment(r, this.options.layer.isCardVisible(r.id));
      return;
    }
    if (msg.type === "heartbeat") {
      r.lastBeat = Date.now();
      this.wire(r, "heartbeat");
      return;
    }
    if (!r.ready || r.status !== "active")
      throw new AppError("widget.staleBinding", "Widget is not ready");
    if (msg.type !== "cancel" && msg.type !== "diag" && !this.options.layer.isCardVisible(r.id))
      throw new AppError("widget.commandDenied", "Widget is not visible");
    const payload =
      msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
        ? msg.payload
        : {};
    if (msg.type === "resize") {
      try {
        if (
          !r.definition.resizable ||
          typeof payload.width !== "number" ||
          typeof payload.height !== "number" ||
          !Number.isFinite(payload.width) ||
          !Number.isFinite(payload.height)
        )
          throw new Error("Widget cannot resize");
        const min = r.definition.minSize ?? { width: 80, height: 32 },
          max = r.definition.maxSize ?? { width: 1200, height: 900 };
        const width = Math.round(Math.min(max.width, Math.max(min.width, payload.width))),
          height = Math.round(Math.min(max.height, Math.max(min.height, payload.height)));
        await this.update(r.stored.widgetInstanceId, {
          bounds: { ...r.stored.bounds, width, height },
        });
        if (replyCurrent()) this.wire(r, "result", { ok: true }, msg.requestId);
      } catch (error) {
        if (replyCurrent())
          this.wire(
            r,
            "result",
            { ok: false, code: "widget.commandDenied", message: String(error).slice(0, 512) },
            msg.requestId,
          );
      }
      return;
    }
    if (msg.type === "open-main") {
      const captured = structuredClone(r.binding);
      const current = () =>
        this.records.get(r.stored.widgetInstanceId) === r &&
        sameWidgetBinding(r.binding, captured) &&
        this.host().manager.isOwnerCurrent(captured.owner) &&
        r.status === "active" &&
        r.stored.visible &&
        r.stored.inputMode === "interactive" &&
        this.options.layer.isCardVisible(r.id) &&
        !this.options.layer.snapshot().editing;
      const requestId = msg.requestId!;
      const controller = new AbortController();
      try {
        const actionId = String(payload.actionId),
          action = r.definition.actions[actionId];
        if (
          !action ||
          action.mode !== "open-main" ||
          !r.definition.interactive ||
          !current() ||
          r.pending.size >= 4 ||
          r.pending.has(requestId) ||
          Date.now() - r.lastInvoke < 1000
        )
          throw new Error("widget.commandDenied");
        r.lastInvoke = Date.now();
        r.pending.set(requestId, controller);
        const { candidate, confirmed } = this.openMainGate.request(
          { cardId: r.id, surfaceId: surface, requestId, actionId, binding: captured },
          controller.signal,
          current,
        );
        void confirmed.catch(() => {});
        const english = this.options.locale().toLowerCase().startsWith("en");
        const command = this.host()
          .manager.describe(r.binding.pluginId)
          .spark233.commands.find((value) => value.id === action.commandId);
        this.options.layer.send(surface, {
          type: "widget-open-main",
          cardId: r.id,
          candidateId: candidate.candidateId,
          widgetInstanceId: r.stored.widgetInstanceId,
          loadGeneration: captured.loadGeneration,
          title: (command?.title ?? r.definition.title).slice(0, 160),
          label: english ? "Open main page" : "打开主页面",
          dismissLabel: english ? "Cancel" : "取消",
          expiresAt: candidate.expiresAt,
        });
        await confirmed;
        controller.signal.throwIfAborted();
        if (!current()) throw new Error("widget.staleBinding");
        const result = await this.host().manager.activateOwned(
          captured.pluginId,
          {
            commandId: action.commandId,
            parameters: { widgetInstanceId: captured.widgetInstanceId, input: null },
          },
          () => {
            controller.signal.throwIfAborted();
            if (!current()) throw new Error("widget.staleBinding");
          },
        );
        controller.signal.throwIfAborted();
        if (current() && samePluginOwner(result.owner, captured.owner))
          this.wire(r, "result", { ok: true }, requestId);
      } catch (error) {
        if (current()) {
          const message = error instanceof Error ? error.message : String(error);
          const code = ["widget.timeout", "widget.cancelled", "widget.staleBinding"].includes(
            message,
          )
            ? message
            : "widget.commandDenied";
          this.wire(
            r,
            "result",
            { ok: false, code, message: message.slice(0, 512) || code },
            requestId,
          );
        }
      } finally {
        controller.abort();
        if (r.pending.get(requestId) === controller) r.pending.delete(requestId);
      }
      return;
    }
    if (msg.type === "invoke") {
      try {
        if (typeof payload.actionId !== "string") throw new Error("Invalid action");
        const result = await this.invoke(
          r.id,
          payload.actionId,
          payload.input,
          false,
          msg.requestId,
        );
        if (!replyCurrent()) return;
        this.wire(r, "result", { ok: true, value: (result ?? null) as JsonValue }, msg.requestId);
      } catch (error) {
        if (replyCurrent())
          this.wire(
            r,
            "result",
            {
              ok: false,
              code: "widget.commandDenied",
              message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
            },
            msg.requestId,
          );
      }
      return;
    }
    if (msg.type === "cancel") {
      if (msg.requestId) r.pending.get(msg.requestId)?.abort();
      return;
    }
    if (msg.type !== "diag")
      throw new AppError("widget.protocolError", "Unsupported widget message");
  }
  private confirmOpenMain(
    surface: string,
    cardId: string,
    candidateId: string,
    allow: boolean,
  ): void {
    const record = [...this.records.values()].find(
      (value) => value.surfaceId === surface && value.id === cardId,
    );
    if (
      !record ||
      !record.ready ||
      record.status !== "active" ||
      !this.host().manager.isOwnerCurrent(record.binding.owner)
    )
      throw new AppError("widget.staleBinding", "Widget confirmation expired");
    // DesktopLayer only calls this after its trusted preload attests activation.
    this.openMainGate.confirm(candidateId, cardId, surface, allow, true);
  }
  private widgetURL(r: RuntimeCard): string {
    if (r.entry.kind !== "web") throw new Error("Not a Web widget");
    return (
      "spark233-widget://" +
      r.hostname +
      "/" +
      path.relative(r.entry.root, r.entry.file).split(path.sep).map(encodeURIComponent).join("/")
    );
  }
  createSurfaceSession(spec: LayerSurfaceSpec, entryURL: string): Electron.Session {
    const s = session.fromPartition("spark233-layer-" + randomUUID(), { cache: false });
    s.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    s.on("will-download", (e) => e.preventDefault());
    const record = spec.card?.widget
      ? this.records.get(spec.card.widget.widgetInstanceId)
      : undefined;
    if (record) {
      record.binding.loadGeneration = ++this.generation;
      record.nonce = randomBytes(16).toString("hex");
      record.hostname = "widget-" + randomUUID();
      record.ready = false;
      record.status = "active";
      record.reason = undefined;
      record.environment = undefined;
      record.handshakeAt = undefined;
      record.providerAttached = false;
      record.incoming = 0;
      record.seq = 0;
      for (const pending of record.pending.values()) pending.abort();
      record.pending.clear();
    }
    const origin = new URL(entryURL).origin;
    let main: Electron.WebContents | undefined;
    let childId: number | undefined;
    let released = false;
    const loadGeneration = record?.binding.loadGeneration;
    const active = () =>
      !released &&
      !this.disposed &&
      (!record ||
        (this.records.get(record.stored.widgetInstanceId) === record &&
          record.binding.loadGeneration === loadGeneration));
    const screenshotHandle = (url: URL): string | undefined => {
      if (
        record ||
        !active() ||
        !main ||
        main.isDestroyed() ||
        url.protocol !== "spark233:" ||
        url.hostname !== "app" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith("/__screenshot-image/")
      )
        return;
      const handle = url.pathname.slice("/__screenshot-image/".length);
      if (!z.uuid().safeParse(handle).success) return;
      const allowed = this.options.layer
        .snapshot(spec.id)
        .cards.some(
          (card) =>
            card.visible &&
            card.renderKind === "screenshot" &&
            card.screenshot?.imageUrl === url.href,
        );
      return allowed ? handle : undefined;
    };
    s.webRequest.onBeforeRequest((details, cb) => {
      let allowed = false;
      try {
        const u = new URL(details.url),
          f = details.frame;
        if (active() && main && details.webContentsId === main.id && f) {
          if (details.resourceType === "mainFrame")
            allowed = f === main.mainFrame && details.url === entryURL;
          else if (f === main.mainFrame) {
            if (u.protocol === "spark233:" && u.pathname.startsWith("/__screenshot-image/"))
              allowed = details.resourceType === "image" && !!screenshotHandle(u);
            else if (
              details.resourceType === "subFrame" &&
              record &&
              details.url === this.widgetURL(record)
            )
              allowed = true;
            else
              allowed =
                details.resourceType !== "subFrame" &&
                ((u.protocol === "spark233:" && u.hostname === "app") ||
                  (this.options.devUrl && u.origin === origin)) === true;
          } else if (record && f.parent === main.mainFrame) {
            if (
              details.resourceType === "subFrame" &&
              details.url === this.widgetURL(record) &&
              (childId === undefined || childId === f.frameTreeNodeId)
            ) {
              childId = f.frameTreeNodeId;
              allowed = true;
            } else
              allowed =
                f.frameTreeNodeId === childId &&
                u.protocol === "spark233-widget:" &&
                u.hostname === record.hostname &&
                ["script", "stylesheet", "image", "font"].includes(details.resourceType);
          }
        }
      } catch {}
      cb({ cancel: !allowed });
    });
    s.protocol.handle("spark233", async (request) => {
      try {
        const u = new URL(request.url);
        if (
          !active() ||
          request.method !== "GET" ||
          u.hostname !== "app" ||
          u.port ||
          u.username ||
          u.password
        )
          throw new Error("Forbidden");
        if (u.pathname.startsWith("/__screenshot-image/")) {
          const handle = screenshotHandle(u);
          if (!handle || !this.options.resolveScreenshotImage) throw new Error("Forbidden");
          const content = await this.options.resolveScreenshotImage(handle);
          if (
            screenshotHandle(u) !== handle ||
            !Buffer.isBuffer(content) ||
            content.length < 24 ||
            content.length > 32 * 1024 * 1024 ||
            !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            throw new Error("Forbidden");
          return new Response(new Uint8Array(content), {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        const relative = decodeURIComponent(u.pathname).slice(1) || "index.html";
        const file = confined(this.options.rendererRoot, relative);
        const ext = path.extname(file).toLowerCase();
        if (!mime[ext] || !fs.statSync(file).isFile()) throw new Error("Forbidden");
        const frameSrc = record ? "spark233-widget://" + record.hostname : "'none'";
        const content = fs.readFileSync(file);
        const scriptHashes =
          ext === ".html"
            ? [
                ...content
                  .toString("utf8")
                  .matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi),
              ]
                .filter((match) => match[1].trim())
                .map(
                  (match) =>
                    "'sha256-" + createHash("sha256").update(match[1]).digest("base64") + "'",
                )
                .join(" ")
            : "";
        return new Response(new Uint8Array(content), {
          headers: {
            "Content-Type": mime[ext],
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": `default-src 'none';script-src 'self' ${scriptHashes};style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self';connect-src 'none';frame-src ${frameSrc};worker-src 'none';object-src 'none';base-uri 'none';form-action 'none'`,
          },
        });
      } catch {
        return new Response("Forbidden", { status: 403 });
      }
    });
    s.protocol.handle("spark233-widget", (request) => {
      try {
        const u = new URL(request.url);
        if (
          !active() ||
          !record ||
          record.entry.kind !== "web" ||
          request.method !== "GET" ||
          u.hostname !== record.hostname ||
          u.port ||
          u.username ||
          u.password ||
          u.hash
        )
          throw new Error("Forbidden");
        let file: string;
        if (u.pathname === "/__sdk__/widget.js")
          file = fileURLToPath(new URL("./widget.js", import.meta.resolve("@spark233/sdk")));
        else {
          const rel = decodeURIComponent(u.pathname).slice(1);
          if (
            !rel ||
            rel.includes("\\") ||
            rel.split("/").some((p) => !p || p === "." || p === ".." || p.includes("%"))
          )
            throw new Error("Forbidden");
          file = confined(record.entry.root, rel);
          if (!inside(fs.realpathSync(record.entry.root), fs.realpathSync(file)))
            throw new Error("Forbidden");
        }
        const ext = path.extname(file).toLowerCase();
        if (
          ![
            ".html",
            ".js",
            ".mjs",
            ".css",
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
            ".woff",
            ".woff2",
          ].includes(ext) ||
          !fs.statSync(file).isFile() ||
          fs.statSync(file).size > (ext === ".html" ? 256 * 1024 : 2 * 1024 * 1024)
        )
          throw new Error("Forbidden");
        const src = "spark233-widget://" + record.hostname;
        return new Response(new Uint8Array(fs.readFileSync(file)), {
          headers: {
            "Content-Type": mime[ext],
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": `default-src 'none';script-src ${src};style-src ${src} 'unsafe-inline';img-src ${src};font-src ${src};connect-src 'none';frame-src 'none';worker-src 'none';object-src 'none';base-uri 'none';form-action 'none'`,
          },
        });
      } catch {
        return new Response("Forbidden", { status: 403 });
      }
    });
    // Bind after BrowserWindow construction, before the first asynchronous load.
    const bind = (contents: Electron.WebContents) => {
      main = contents;
      contents.once("destroyed", () => {
        released = true;
        this.sessionBinders.delete(s);
        s.webRequest.onBeforeRequest(null);
        s.protocol.unhandle("spark233");
        s.protocol.unhandle("spark233-widget");
        void s.clearCache().catch(() => {});
      });
      contents.on("will-frame-navigate", (event) => {
        if (event.isMainFrame || !record || event.url !== this.widgetURL(record))
          event.preventDefault();
      });
      contents.on("will-redirect", (e) => e.preventDefault());
    };
    this.sessionBinders.set(s, bind);
    return s;
  }
  private sessionBinders = new WeakMap<
    Electron.Session,
    (contents: Electron.WebContents) => void
  >();
  bindSession(s: Electron.Session, contents: Electron.WebContents): void {
    this.sessionBinders.get(s)?.(contents);
  }
  private diagnostic(code: string, error: unknown): void {
    this.options.diagnostic(code, {
      message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.clock);
    if (this.edgeFrame) clearTimeout(this.edgeFrame);
    this.edgeFrame = undefined;
    this.openMainGate.dispose();
    this.releaseStore();
    for (const r of this.records.values()) this.drop(r);
    this.releaseConsumer();
    await this.queue.catch(() => {});
  }
}
