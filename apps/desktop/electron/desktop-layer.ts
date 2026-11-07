import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { sameWidgetBinding, type JsonValue, type WidgetDataFrame } from "@spark233/sdk";
import type { Rect } from "../src/features/capsules/types.js";
import type {
  DisplayArea,
  LayerCard,
  LayerChange,
  LayerConsumer,
  LayerEvent,
  LayerMutation,
  LayerRenderCard,
  LayerRequest,
  LayerSnapshot,
  SurfaceKey,
  DesktopOverlayLauncher,
  DesktopOverlayPanel,
} from "../shared/layer-contract.js";
import { LayerWindow, computeShape, surfaceKey } from "./layer-window.js";
import { contains } from "./capsule-layout.js";
import { LayerLayoutStore, constrainLayerCard } from "./layer-layout-store.js";
import { AppError } from "./persistence.js";
import type {
  ExternalLayerParticipant,
  ExternalLayerPresentation,
} from "../shared/utools-desktop.js";
import {
  DesktopOverlayLayout,
  overlayPanelKind,
  overlayPanelKey,
  overlayInteractionBounds,
  overlayViewport,
} from "./desktop-overlay-layout.js";

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const rect = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: z.number().positive().max(32768),
  height: z.number().positive().max(32768),
});
const mutation = z.strictObject({
  cardId: z.string().min(1).max(160),
  patch: z.strictObject({
    displayId: z.string().min(1).max(160).optional(),
    group: z.enum(["top", "normal"]).optional(),
    bounds: rect.optional(),
    order: z.number().int().safe().optional(),
    visible: z.boolean().optional(),
  }),
});
const pointerEvent = z.strictObject({
  cardId: z.string().min(1).max(160),
  revision: z.number().int().nonnegative().safe(),
  pointerId: z.number().int().nonnegative().safe(),
  type: z.enum([
    "enter",
    "leave",
    "down",
    "move",
    "up",
    "cancel",
    "click",
    "doubleclick",
    "contextmenu",
    "wheel",
  ]),
  x: z.number().finite().min(-32768).max(32768),
  y: z.number().finite().min(-32768).max(32768),
  screenX: coordinate,
  screenY: coordinate,
  buttons: z.number().int().min(0).max(63),
  button: z.enum(["left", "right", "middle", "none"]),
  deltaX: z.number().finite().min(-120).max(120).optional(),
  deltaY: z.number().finite().min(-120).max(120).optional(),
  modifiers: z.strictObject({
    alt: z.boolean(),
    ctrl: z.boolean(),
    shift: z.boolean(),
    meta: z.boolean(),
  }),
  cancelledBy: z.enum(["capture-lost", "display-change", "hidden", "disposed"]).optional(),
});
export interface LayerSurfaceSpec {
  id: string;
  generation: number;
  bounds: Rect;
  group: "normal" | "top";
  inputMode: "passive" | "interactive";
  card?: LayerCard;
  overlay?: boolean;
  closed: () => void;
  fault: (code: string, error: Error) => void;
}
export interface DesktopLayerOptions {
  store: LayerLayoutStore;
  displays: () => readonly DisplayArea[];
  primaryDisplay: () => string;
  /** Native screen DIPs. Renderer screenX changes coordinate space across DPI. */
  cursor?: () => { x: number; y: number };
  createWindow: (spec: LayerSurfaceSpec) => { window: LayerWindow; entryURL: string };
  theme: () => "light" | "dark";
  locale: () => string;
  flags: () => { enabled: boolean; notesEnabled: boolean; webEnabled: boolean };
  diagnostic: (code: string, detail: JsonValue) => void;
  overlayLayout?: DesktopOverlayLayout;
  onOverlayClosed?: (restoreFocus: boolean) => void | Promise<void>;
  onOverlayOpenPanel?: (card: LayerCard) => Promise<void>;
  onOverlaySettings?: () => void | Promise<void>;
  /** Plugin windows the plugin bar offers under "Add plugin". */
  overlayLaunchers?: () => DesktopOverlayLauncher[];
  onOverlayLaunch?: (pluginId: string, commandId: string) => Promise<void>;
  onOverlayFavorite?: (pluginId: string, commandId: string, value: boolean) => void;
  onOverlayPresentation?: (
    card: LayerCard,
    patch: { group?: "top" | "normal"; inputMode?: "passive" | "interactive" },
  ) => Promise<boolean>;
}
interface Surface {
  id: string;
  displayId: string;
  generation: number;
  window: LayerWindow;
  entryURL: string;
  cards: LayerCard[];
  bounds: Rect;
  lastSeq: number;
  lastBeat: number;
  created: number;
  focusable?: boolean;
  passive?: boolean;
  publishedSnapshot?: LayerSnapshot;
  mode?: string;
  presentationRevision?: number;
  commit?: { promise: Promise<boolean>; finish: (ok: boolean) => void };
}

interface OverlaySession {
  displayId: string;
  id: string;
  epoch: number;
  owners: Map<string, string>;
  members: Set<string>;
  drafts: Map<string, Rect>;
  previews: Set<string>;
  menus: Set<string>;
}

/** Reuses LayerWindow and the durable layout store; only coordinates trusted
 * consumers and their renderer identities. It never resolves plugin paths. */
export class DesktopLayer {
  private overlay?: OverlaySession;
  private overlayEpoch = 0;
  private presentationRevision = 0;
  private overlayClosing?: Promise<void>;
  private overlayGesture?: {
    surfaceId: string;
    cardId: string;
    pointerId: number;
    cursor: { x: number; y: number };
    bounds: Rect;
  };
  private overlayLayout: DesktopOverlayLayout;
  private consumers = new Map<string, LayerConsumer>();
  private external = new Map<
    string,
    {
      participant: ExternalLayerParticipant;
      value?: ExternalLayerPresentation;
      pending?: Promise<void>;
    }
  >();
  private surfaces = new Map<string, Surface>();
  private cards = new Map<string, LayerCard>();
  private generation = 0;
  private disposed = false;
  private pending = false;
  private stackSignature = "";
  private hidden = new Set<string>();
  private fullscreen: readonly Rect[] = [];
  private editor?: ReturnType<LayerLayoutStore["beginEdit"]>;
  private editGesture?: {
    surfaceId: string;
    cardId: string;
    pointerId: number;
    mode: "move" | "resize";
    cursor: { x: number; y: number };
    bounds: Rect;
    latest: Rect;
  };
  private editBounds = new Map<string, Rect>();
  private screenChanges: Promise<void> = Promise.resolve();
  private releaseStore: () => void;
  private monitor: ReturnType<typeof setInterval>;
  private recovering = new Map<
    string,
    { count: number; since: number; timer?: ReturnType<typeof setTimeout> }
  >();
  onAction?: (
    cardId: string,
    actionId: string,
    input: JsonValue | undefined,
    userGesture: boolean,
  ) => Promise<unknown>;
  onRelay?: (surfaceId: string, binding: unknown, wire: string) => Promise<void> | void;
  onReady?: (surfaceId: string, cardId?: string) => void;
  onConfirmOpen?: (
    surfaceId: string,
    cardId: string,
    candidateId: string,
    allow: boolean,
  ) => Promise<void> | void;

  constructor(readonly options: DesktopLayerOptions) {
    this.overlayLayout = options.overlayLayout ?? new DesktopOverlayLayout();
    this.overlayLayout.liveKeys = () =>
      new Set([...this.cards.values()].map((card) => overlayPanelKey(card)));
    this.releaseStore = options.store.subscribe(() => this.refresh());
    let lastTick = Date.now();
    this.monitor = setInterval(() => {
      const now = Date.now();
      // Sleep, lock or a throttled main process delays this timer itself; judge
      // nothing on that tick, otherwise every surface looks stale at once.
      const stalled = now - lastTick > 3000;
      lastTick = now;
      for (const surface of this.surfaces.values()) {
        // Hidden surfaces are throttled by Chromium and are not judged; restart
        // their grace window so showing them again does not trigger a recovery.
        if (stalled || !surface.window.win.isVisible()) {
          surface.lastBeat = now;
          continue;
        }
        if (now - surface.lastBeat > 7000)
          this.recover(
            surface.id,
            "heartbeat-timeout",
            new Error("Desktop surface stopped responding"),
          );
      }
    }, 1000);
    this.monitor.unref();
  }
  register(consumer: LayerConsumer): () => void {
    if (this.disposed || this.consumers.has(consumer.id))
      throw new Error("Desktop consumer already registered or released");
    this.consumers.set(consumer.id, consumer);
    this.refresh();
    return () => {
      if (this.consumers.get(consumer.id) !== consumer) return;
      this.consumers.delete(consumer.id);
      void consumer.onDispose?.();
      this.refresh();
    };
  }
  /** Compatibility HWNDs remain owned by their runner. Only the trusted host
   * registers participants; renderer requests cannot acquire a window identity. */
  registerExternal(cardId: string, participant: ExternalLayerParticipant): () => void {
    if (this.disposed || this.external.has(cardId))
      throw new Error("Duplicate external desktop card");
    const entry = { participant };
    this.external.set(cardId, entry);
    this.refresh();
    return () => {
      if (this.external.get(cardId) !== entry) return;
      this.external.delete(cardId);
      this.refresh();
    };
  }
  externalPresentation(cardId: string): ExternalLayerPresentation | undefined {
    return this.external.get(cardId)?.value;
  }
  async externalBounds(cardId: string, bounds: Rect): Promise<void> {
    const card = this.cards.get(cardId);
    if (!card || !this.external.has(cardId) || this.editor)
      throw new AppError("permissionDenied", "兼容桌面窗口已失效");
    const requested = rect.parse(bounds);
    const session = this.overlay;
    if (session) {
      const previous = this.external.get(cardId)?.value;
      if (previous?.mode !== "overlay") throw new AppError("permissionDenied", "插件栏会话已失效");
      // Native resize changes the one shared content size, while its desktop
      // origin remains independent of the operation bar's position.
      this.overlayLayout.position(
        overlayPanelKey(card),
        session.displayId,
        this.clampOverlay(requested),
      );
      await this.commit(
        [
          {
            cardId,
            patch: { bounds: { ...card.bounds, width: requested.width, height: requested.height } },
          },
        ],
        this.options.store.load().revision,
      );
      this.refresh();
    } else {
      const display = this.options.displays().find((d) =>
        contains(d.workArea, {
          x: requested.x + requested.width / 2,
          y: requested.y + requested.height / 2,
        }),
      );
      const layout = this.options.store.load();
      const stored = layout.cards[cardId];
      if (stored?.kind !== "utools" && stored?.kind !== "window")
        throw new AppError("permissionDenied", "桌面窗口已失效");
      layout.cards[cardId] = constrainLayerCard(
        {
          ...stored,
          bounds: requested,
          ...(display ? { displayId: display.id, workAreaAtSave: display.workArea } : {}),
        },
        this.options.displays(),
        this.options.primaryDisplay(),
      ).card;
      await this.options.store.commit(
        { ...layout, revision: layout.revision + 1 },
        layout.revision,
      );
    }
  }
  async externalPanel(
    cardId: string,
    action: "show" | "hide" | "pin" | "passthrough" | "open",
    value?: boolean,
  ): Promise<unknown> {
    if (!this.external.has(cardId)) throw new AppError("permissionDenied", "兼容桌面窗口已失效");
    return this.panelAction(cardId, action, value);
  }
  private cancelConsumerPointers(): void {
    for (const consumer of this.consumers.values()) {
      try {
        consumer.onPointersCancelled?.();
      } catch (error) {
        this.diagnostic("pointer-cancel", error);
      }
    }
  }
  refresh(_consumerId?: string): void {
    if (this.disposed || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.disposed)
        try {
          this.reconcile();
        } catch (error) {
          this.diagnostic("reconcile", error);
        }
    });
  }
  private reconcile(): void {
    const saved = this.editor?.layout ?? this.options.store.load();
    const displays = this.options.displays();
    const next = new Map<string, LayerCard>();
    for (const consumer of this.consumers.values())
      for (const provided of consumer.snapshot()) {
        if (next.has(provided.id)) throw new Error("Duplicate desktop card identity");
        const stored = saved.cards[provided.id];
        let card = { ...provided, consumerId: consumer.id };
        // The trusted screenshot consumer already projects durable layout and
        // can temporarily move its image during pointer capture. Editor drafts
        // still use the shared store transaction as the sole geometry source.
        if (
          stored &&
          (this.editor || (!card.transientGeometry && card.renderKind !== "screenshot"))
        ) {
          const constrained = constrainLayerCard(
            stored,
            displays,
            this.options.primaryDisplay(),
          ).card;
          card = {
            ...card,
            displayId: constrained.displayId,
            bounds: constrained.bounds,
            group: constrained.group,
            inputMode: constrained.inputMode,
            visible: constrained.visible,
            order: constrained.order,
          };
        }
        let presentation = this.overlayLayout.get(overlayPanelKey(card));
        if (
          presentation &&
          ((presentation.sourceGroup && presentation.sourceGroup !== card.group) ||
            (presentation.sourceInputMode && presentation.sourceInputMode !== card.inputMode))
        ) {
          this.overlayLayout.update(overlayPanelKey(card), {
            pinned: undefined,
            passthrough: undefined,
            sourceGroup: undefined,
            sourceInputMode: undefined,
          });
          presentation = this.overlayLayout.get(overlayPanelKey(card));
        }
        if (presentation?.pinned !== undefined) card.group = presentation.pinned ? "top" : "normal";
        if (presentation?.passthrough !== undefined)
          card.inputMode = presentation.passthrough ? "passive" : "interactive";
        next.set(card.id, card);
      }
    this.cards = next;
    const groups = new Map<string, { cards: LayerCard[]; bounds: Rect; display: DisplayArea }>();
    // Keep the initiating editor alive even when its last card moves to another
    // display. It must still be able to finish the shared edit transaction.
    if (this.editor && this.options.flags().enabled && !this.options.store.readError)
      for (const display of displays)
        groups.set(JSON.stringify([display.id, "top", "interactive"]), {
          cards: [],
          bounds: display.workArea,
          display,
        });
    if (this.options.flags().enabled && !this.options.store.readError)
      for (let card of next.values()) {
        if ((card.renderKind === "utools" || card.renderKind === "window") && !this.editor)
          continue;
        if (this.editor && card.presentationOnly) continue;
        if (!card.visible && !this.editor) continue;
        if (card.renderKind === "notes" && !this.options.flags().notesEnabled) continue;
        if (card.renderKind === "web" && !this.options.flags().webEnabled) continue;
        if (
          !this.editor &&
          !(this.overlay && overlayPanelKind(card)) &&
          card.renderKind !== "notes" &&
          card.renderKind !== "screenshot" &&
          card.fullscreenAutoHide !== false &&
          this.fullscreen.some((area) =>
            contains(area, {
              x: card.bounds.x + card.bounds.width / 2,
              y: card.bounds.y + card.bounds.height / 2,
            }),
          )
        )
          continue;
        const display = displays.find((d) => d.id === card.displayId) ?? displays[0];
        if (!display) continue;
        if (this.editor) card = { ...card, group: "top", inputMode: "interactive", visible: true };
        const key = this.cardSurfaceKey(card);
        let group = groups.get(key);
        if (!group) {
          group = {
            cards: [],
            bounds: key.startsWith("web:") ? card.bounds : display.workArea,
            display,
          };
          groups.set(key, group);
        }
        group.cards.push(card);
      }
    const session = this.overlay;
    const overlayDisplay = displays.find((d) => d.id === session?.displayId);
    if (session && overlayDisplay && this.options.flags().enabled) {
      // Membership stays with its original trusted renderer. Only native and
      // rendered geometry are projected; source cards/layout are never rewritten.
      const panels = this.overlayPanels();
      for (const [key, group] of groups) {
        if (key.startsWith("web:")) continue;
        for (const card of group.cards)
          if (overlayPanelKind(card)) session.owners.set(card.id, key);
        if (!session.members.has(key) && !group.cards.some((c) => overlayPanelKind(c))) continue;
        session.members.add(key);
        group.cards = group.cards.map((card) => {
          const index = panels.findIndex((p) => p.cardId === card.id);
          const panel = panels[index];
          if (!panel) return { ...card, visible: false };
          const bounds =
            session.drafts.get(card.id) ??
            this.overlayLayout.place(card, overlayDisplay.id, overlayDisplay.workArea, index);
          const regions = overlayInteractionBounds({ ...card, bounds }, overlayDisplay.workArea);
          return {
            ...card,
            bounds,
            visible: panel.selected,
            displayId: overlayDisplay.id,
            clip: undefined,
            desktopInteractive: false,
            presentationHidden: false,
            overlayControls: regions.controls,
            overlayPreview: regions.preview,
          };
        });
        group.display = overlayDisplay;
        group.bounds =
          key === session.id
            ? overlayDisplay.workArea
            : overlayViewport(group.cards, overlayDisplay.workArea);
      }
      if (!groups.has(session.id))
        groups.set(session.id, {
          cards: [],
          bounds: overlayDisplay.workArea,
          display: overlayDisplay,
        });
    }
    for (const [key, group] of groups) {
      if (!this.editor && !session?.members.has(key) && key.includes(":widget-family:")) {
        // Reuse the native shape's clipping/rounding for a local widget viewport.
        // Its stable family key keeps the same renderer/capture during movement.
        // A source-only hidden drag anchor still needs its HWND for capture.
        let shape = computeShape(
          group.cards.filter((card) => !card.presentationHidden),
          group.display.workArea,
        );
        if (!shape.length) shape = computeShape(group.cards, group.display.workArea);
        if (shape.length) {
          const x = Math.min(...shape.map((region) => region.x));
          const y = Math.min(...shape.map((region) => region.y));
          group.bounds = {
            x: group.display.workArea.x + x,
            y: group.display.workArea.y + y,
            width: Math.max(...shape.map((region) => region.x + region.width)) - x,
            height: Math.max(...shape.map((region) => region.y + region.height)) - y,
          };
        }
      }
    }
    for (const [key, surface] of this.surfaces)
      if (!groups.has(key)) {
        this.surfaces.delete(key);
        surface.commit?.finish(false);
        void surface.window.destroy();
      }
    for (const [key, group] of groups) {
      group.cards.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      let surface = this.surfaces.get(key);
      if (!surface) {
        const recovery = this.recovering.get(key);
        if (recovery?.timer || (recovery && recovery.count > 3)) continue;
        const generation = ++this.generation;
        const spec: LayerSurfaceSpec = {
          id: key,
          generation,
          bounds: group.bounds,
          group: group.cards[0]?.group ?? "top",
          inputMode: group.cards[0]?.inputMode ?? "interactive",
          ...(key === this.overlay?.id
            ? { overlay: true, group: "top", inputMode: "interactive" }
            : {}),
          ...(key.startsWith("web:") ? { card: group.cards[0] } : {}),
          closed: () => {
            const current = this.surfaces.get(key);
            if (current?.generation === generation) {
              if (!this.disposed) this.recover(key, "closed", new Error("Desktop window closed"));
            }
          },
          fault: (code, error) => {
            if (this.surfaces.get(key)?.generation === generation) this.recover(key, code, error);
          },
        };
        let created: ReturnType<DesktopLayerOptions["createWindow"]>;
        try {
          created = this.options.createWindow(spec);
        } catch (error) {
          this.recover(
            key,
            "create-failed",
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
        surface = {
          id: key,
          displayId: group.display.id,
          generation,
          window: created.window,
          entryURL: created.entryURL,
          cards: group.cards,
          bounds: group.bounds,
          lastSeq: 0,
          lastBeat: Date.now(),
          created: Date.now(),
        };
        this.surfaces.set(key, surface);
      }
      const isOverlay = !!session?.members.has(key);
      const mode = isOverlay ? "overlay:" + session!.epoch : "desktop";
      const transition =
        (surface.mode !== undefined && surface.mode !== mode) ||
        (isOverlay && surface.mode === undefined) ||
        (isOverlay &&
          (surface.bounds.width !== group.bounds.width ||
            surface.bounds.height !== group.bounds.height) &&
          !this.overlayGesture);
      if (transition) this.beginPresentation(surface);
      surface.mode = mode;
      surface.cards = group.cards;
      surface.displayId = group.display.id;
      surface.bounds = group.bounds;
      surface.window.setPresentation(
        isOverlay ? "top" : (group.cards[0]?.group ?? "top"),
        isOverlay ? "interactive" : (group.cards[0]?.inputMode ?? "interactive"),
      );
      const focusable = !!this.editor || isOverlay;
      const passive = !this.editor && !isOverlay && group.cards[0]?.inputMode === "passive";
      if (surface.focusable !== focusable) {
        surface.window.win.setFocusable(focusable);
        surface.focusable = focusable;
      }
      if (surface.passive !== passive) {
        surface.window.win.setIgnoreMouseEvents(passive);
        surface.passive = passive;
      }
      for (const reason of ["user", "locked", "suspend"] as const)
        surface.window.setSuppressed(
          reason,
          (isOverlay && reason === "user"
            ? false
            : this.hidden.has(reason) || this.hidden.has(reason + ":" + group.display.id)) ||
            (reason === "user" &&
              !!this.overlay &&
              !isOverlay &&
              group.display.id === this.overlay.displayId),
        );
      surface.window.setFullscreenBehavior(
        // Ordinary cards were filtered individually above. A shared surface
        // must not hide a remaining opt-out card because another card hid.
        isOverlay ||
          (group.cards.length > 0 && group.cards.every((card) => card.fullscreenAutoHide === false))
          ? "keep"
          : "lower",
      );
      surface.window.setFullscreen(this.fullscreen);
      const hitCards =
        this.editor || key === session?.id
          ? [
              {
                id: "editor:" + group.display.id,
                displayId: group.display.id,
                group: "top" as const,
                inputMode: "interactive" as const,
                order: 0,
                bounds: group.bounds,
                visible: true,
              },
            ]
          : isOverlay
            ? group.cards.flatMap((card) => {
                if (!card.visible) return [];
                const regions = [
                  card.bounds,
                  card.overlayControls && {
                    ...card.overlayControls,
                    height: card.overlayControls.height + 4,
                  },
                ];
                if (session!.previews.has(card.id) && card.overlayPreview) {
                  const preview = card.overlayPreview;
                  const top = Math.min(preview.y, card.bounds.y);
                  regions.push({
                    ...preview,
                    y: top,
                    height:
                      Math.max(preview.y + preview.height, card.bounds.y + card.bounds.height) -
                      top,
                  });
                }
                // Base UI positions its menu inside the reserved native viewport.
                if (session!.menus.has(card.id)) regions.push(group.bounds);
                return regions
                  .filter((r): r is Rect => !!r)
                  .map((bounds, i) => ({
                    ...card,
                    id: card.id + ":hit:" + i,
                    bounds,
                    clip: undefined,
                  }));
              })
            : group.cards;
      surface.window.apply(hitCards, group.bounds, () => this.publishSnapshot(surface));
    }
    this.presentExternal();
    this.restack();
  }
  private presentExternal(): void {
    const displays = this.options.displays();
    const panels = this.overlayPanels();
    for (const [id, entry] of this.external) {
      const card = this.cards.get(id);
      if (!card) continue;
      const session = this.overlay;
      const display =
        displays.find((d) => d.id === (session?.displayId ?? card.displayId)) ?? displays[0];
      if (!display) continue;
      const selected = panels.find((p) => p.cardId === id)?.selected === true;
      const projected = session
        ? {
            ...card,
            displayId: display.id,
            bounds: this.overlayLayout.place(
              card,
              display.id,
              display.workArea,
              panels.findIndex((p) => p.cardId === id),
            ),
          }
        : card;
      const hidden = ["user", "locked", "suspend"].some(
        (reason) =>
          !(session && reason === "user") &&
          (this.hidden.has(reason) || this.hidden.has(reason + ":" + display.id)),
      );
      const value: ExternalLayerPresentation = {
        mode: session ? "overlay" : "desktop",
        card: projected,
        area: display.workArea,
        visible:
          this.options.flags().enabled &&
          !this.options.store.readError &&
          !this.editor &&
          !hidden &&
          (session ? selected : card.visible),
        locale: this.options.locale(),
        ...(session ? { epoch: session.epoch } : {}),
      };
      if (isDeepStrictEqual(entry.value, value)) continue;
      entry.value = structuredClone(value);
      const pending = entry.participant.present(value).catch((error) => {
        if (this.external.get(id) !== entry) return;
        this.diagnostic("external-presentation", error);
        if (this.overlay?.epoch === value.epoch && value.mode === "overlay")
          void this.closeOverlay(false);
      });
      entry.pending = pending;
      void pending.finally(() => {
        if (entry.pending === pending) entry.pending = undefined;
      });
    }
  }
  private async waitExternalPresentations(): Promise<void> {
    for (const entry of this.external.values()) {
      let pending = entry.pending;
      while (pending) {
        await pending;
        if (entry.pending === pending) break;
        pending = entry.pending;
      }
    }
  }
  private restack(): void {
    // Moving a card inside an existing surface does not change HWND ordering.
    // Visibility, recovery generations and fullscreen transitions still do.
    const signature = JSON.stringify([
      this.fullscreen,
      [...this.hidden].sort(),
      this.overlay?.epoch,
      [...this.surfaces.values()].map((s) => [s.id, s.generation, s.window.win.isVisible()]),
    ]);
    if (signature === this.stackSignature) return;
    const ordered = [...this.surfaces.values()].sort((a, b) =>
      a.id === this.overlay?.id ? -1 : b.id === this.overlay?.id ? 1 : 0,
    );
    LayerWindow.restack(ordered.map((s) => s.window));
    let previous = this.overlay && this.surfaces.get(this.overlay.id);
    for (const id of this.overlay?.members ?? []) {
      const member = this.surfaces.get(id);
      if (!member || member === previous || !member.window.win.isVisible()) continue;
      if (previous?.window.win.isVisible())
        member.window.win.moveAbove(previous.window.win.getMediaSourceId());
      previous = member;
    }
    this.stackSignature = signature;
  }
  private publishSnapshot(surface: Surface, force = false): LayerSnapshot {
    const snapshot = this.snapshot(surface.id);
    const previous = surface.publishedSnapshot;
    if (!force && isDeepStrictEqual(snapshot, previous)) return snapshot;
    // Keep the existing full snapshot for membership, content or context changes.
    // A drag only changes bounds, so retain the renderer's templates/data and send
    // the small geometry delta through the same generation-bound channel.
    let geometry: { cardId: string; bounds: Rect }[] | undefined;
    if (
      !force &&
      previous &&
      snapshot.cards.length === previous.cards.length &&
      isDeepStrictEqual(
        { ...snapshot, cards: undefined, bounds: undefined },
        { ...previous, cards: undefined, bounds: undefined },
      )
    ) {
      geometry = [];
      for (let i = 0; i < snapshot.cards.length; i++) {
        const card = snapshot.cards[i]!;
        const old = previous.cards[i]!;
        if (isDeepStrictEqual(card, old)) continue;
        if (!isDeepStrictEqual({ ...card, bounds: old.bounds }, old)) {
          geometry = undefined;
          break;
        }
        geometry.push({ cardId: card.id, bounds: card.bounds });
      }
    }
    this.send(
      surface.id,
      geometry
        ? {
            type: "geometry",
            surfaceGeneration: snapshot.surfaceGeneration,
            revision: snapshot.revision,
            bounds: snapshot.bounds,
            cards: geometry,
          }
        : { type: "snapshot", snapshot },
    );
    // Consumers may reuse and mutate their geometry objects between callbacks.
    // Compare against the value actually sent, not a reference they still own.
    surface.publishedSnapshot = geometry
      ? {
          ...previous!,
          bounds: snapshot.bounds && { ...snapshot.bounds },
          cards: previous!.cards.map((card) => {
            const move = geometry.find((item) => item.cardId === card.id);
            return move ? { ...card, bounds: { ...move.bounds } } : card;
          }),
        }
      : structuredClone(snapshot);
    return snapshot;
  }
  snapshot(id: SurfaceKey = ""): LayerSnapshot {
    const surface = this.surfaces.get(id);
    const cards = (surface?.cards ?? [...this.cards.values()]).map((card) => {
      const { widget, ...rest } = card;
      return {
        ...rest,
        consumerId: card.consumerId ?? "",
        renderKind: card.renderKind ?? "notes",
        renderRef: card.renderRef ?? card.id,
        ...(widget
          ? {
              widget: {
                pluginId: widget.pluginId,
                widgetDefinitionId: widget.widgetDefinitionId,
                widgetInstanceId: widget.widgetInstanceId,
                loadGeneration: widget.loadGeneration,
              },
            }
          : {}),
      } as LayerRenderCard;
    });
    const display = this.options.displays().find((d) => d.id === surface?.displayId);
    return {
      protocol: 1,
      surfaceId: id,
      surfaceGeneration: surface?.generation ?? 0,
      revision: this.options.store.load().revision,
      theme: this.options.theme(),
      locale: this.options.locale(),
      scaleFactor: display?.scaleFactor ?? 1,
      bounds: surface?.window.win.getBounds(),
      editing: !!this.editor,
      editSession: this.editor?.id,
      cards,
      presentationRevision: surface?.presentationRevision,
      ...(this.overlay?.members.has(id)
        ? {
            overlay: {
              displayId: this.overlay.displayId,
              epoch: this.overlay.epoch,
              host: id === this.overlay.id,
              workArea: this.options.displays().find((d) => d.id === this.overlay!.displayId)
                ?.workArea,
              panels: this.overlayPanels().filter(
                (p) => id === this.overlay!.id || surface?.cards.some((c) => c.id === p.cardId),
              ),
              ...(id === this.overlay.id && this.options.overlayLaunchers
                ? { launchers: this.options.overlayLaunchers() }
                : {}),
            },
          }
        : {}),
    };
  }
  async handle(event: Electron.IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 128 * 1024)
      throw new AppError("permissionDenied", "Invalid layer request");
    const input = value as LayerRequest & { userGesture?: boolean };
    const surface = this.surfaces.get(input.surfaceId);
    if (
      this.disposed ||
      !surface ||
      surface.window.win.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== surface.entryURL ||
      input.protocol !== 1 ||
      input.surfaceGeneration !== surface.generation ||
      !Number.isSafeInteger(input.seq) ||
      input.seq <= surface.lastSeq
    )
      throw new AppError("permissionDenied", "Desktop surface identity expired");
    surface.lastSeq = input.seq;
    switch (input.type) {
      case "ready":
        surface.lastBeat = Date.now();
        surface.window.markReady();
        this.publishSnapshot(surface, true);
        surface.window.show();
        this.restack();
        if (this.editor || surface.id === this.overlay?.id) surface.window.win.focus();
        this.onReady?.(
          surface.id,
          surface.cards[0]?.renderKind === "web" ? surface.cards[0].id : undefined,
        );
        return this.snapshot(surface.id);
      case "presentation-committed":
        if (input.revision === surface.presentationRevision) surface.commit?.finish(true);
        return;
      case "heartbeat":
        surface.lastBeat = Date.now();
        return;
      case "content-height": {
        if (this.overlay?.members.has(surface.id)) return;
        const card = surface.cards.find((item) => item.id === input.cardId);
        if (
          this.editor ||
          !card?.intrinsicHeight ||
          card.renderKind !== "declarative" ||
          !this.isCardVisible(card.id)
        )
          throw new AppError("permissionDenied", "Desktop content sizing is unavailable");
        const height = z.number().finite().positive().max(32768).parse(input.height);
        this.consumers.get(card.consumerId!)?.onContentHeight?.(card.id, height);
        return;
      }
      case "overlay-close":
        this.assertOverlaySurface(surface, input.overlayEpoch);
        return this.closeOverlay(true);
      case "overlay-settings":
        this.assertOverlaySurface(surface, input.overlayEpoch);
        await this.closeOverlay(false);
        return this.options.onOverlaySettings?.();
      case "overlay-launch":
      case "overlay-favorite": {
        this.assertOverlaySurface(surface, input.overlayEpoch);
        if (surface.id !== this.overlay!.id)
          throw new AppError("permissionDenied", "Only the plugin bar can open plugins");
        // Only entries the host offered can be opened or starred.
        const entry = this.options
          .overlayLaunchers?.()
          .find((item) => item.pluginId === input.pluginId && item.commandId === input.commandId);
        if (!entry) throw new AppError("pluginDisabled", "插件不可用");
        if (input.type === "overlay-favorite") {
          this.options.onOverlayFavorite?.(entry.pluginId, entry.commandId, input.value === true);
          this.refresh();
          return;
        }
        await this.closeOverlay(false);
        return this.options.onOverlayLaunch?.(entry.pluginId, entry.commandId);
      }
      case "overlay-layout": {
        this.assertOverlaySurface(surface, input.overlayEpoch, input.cardId);
        const card = this.cards.get(input.cardId);
        if (!card || !overlayPanelKind(card))
          throw new AppError("permissionDenied", "插件栏面板已失效");
        const area = this.options
          .displays()
          .find((d) => d.id === this.overlay!.displayId)!.workArea;
        const requested = rect.parse(input.bounds);
        const projected = this.surfaces
          .get(this.surfaceForCard(card.id)!)!
          .cards.find((item) => item.id === card.id)!;
        const bounds = this.clampOverlay({ ...projected.bounds, x: requested.x, y: requested.y });
        if (bounds.width > area.width || bounds.height > area.height)
          throw new AppError("permissionDenied", "插件栏面板超出屏幕范围");
        this.overlayLayout.position(overlayPanelKey(card), this.overlay!.displayId, bounds);
        this.refresh();
        return;
      }
      case "overlay-preview": {
        this.assertOverlaySurface(surface, input.overlayEpoch, input.cardId);
        if (!surface.cards.some((c) => c.id === input.cardId && c.visible))
          throw new AppError("permissionDenied", "面板不可见");
        const set = input.region === "menu" ? this.overlay!.menus : this.overlay!.previews;
        if (z.boolean().parse(input.visible)) set.add(input.cardId);
        else set.delete(input.cardId);
        this.reconcile();
        return;
      }
      case "overlay-pointer": {
        this.assertOverlaySurface(surface, input.overlayEpoch, input.cardId);
        const projected = surface.cards.find((c) => c.id === input.cardId && c.visible);
        if (
          !projected ||
          !overlayPanelKind(projected) ||
          !this.options.cursor ||
          !Number.isSafeInteger(input.pointerId) ||
          input.pointerId < 0
        )
          throw new AppError("permissionDenied", "面板拖动不可用");
        if (input.phase === "start") {
          const p = input.clientPoint;
          const origin = surface.window.win.getBounds();
          if (
            this.overlayGesture ||
            !p ||
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y) ||
            !projected.overlayControls ||
            !contains(projected.overlayControls, {
              x: origin.x + p.x,
              y: origin.y + p.y,
            })
          )
            throw new AppError("permissionDenied", "拖动起点不在控制栏");
          this.overlayGesture = {
            surfaceId: surface.id,
            cardId: projected.id,
            pointerId: input.pointerId,
            cursor: { x: origin.x + p.x, y: origin.y + p.y },
            bounds: { ...projected.bounds },
          };
          return;
        }
        const gesture = this.overlayGesture;
        if (
          !gesture ||
          gesture.surfaceId !== surface.id ||
          gesture.cardId !== input.cardId ||
          gesture.pointerId !== input.pointerId
        )
          return;
        const session = this.overlay!;
        if (input.phase === "cancel") {
          this.overlayGesture = undefined;
          session.drafts.delete(input.cardId);
          this.reconcile();
          return;
        }
        if (input.phase !== "move" && input.phase !== "end")
          throw new AppError("permissionDenied", "未知拖动阶段");
        const cursor = this.options.cursor();
        const bounds = this.clampOverlay({
          ...gesture.bounds,
          x: gesture.bounds.x + cursor.x - gesture.cursor.x,
          y: gesture.bounds.y + cursor.y - gesture.cursor.y,
        });
        session.drafts.set(input.cardId, bounds);
        if (input.phase === "end") {
          this.overlayGesture = undefined;
          try {
            this.overlayLayout.position(
              overlayPanelKey(this.cards.get(input.cardId)!),
              session.displayId,
              bounds,
            );
          } finally {
            session.drafts.delete(input.cardId);
            this.reconcile();
          }
        } else this.reconcile();
        return;
      }
      case "overlay-panel": {
        this.assertOverlaySurface(surface, input.overlayEpoch, input.cardId);
        return this.panelAction(input.cardId, input.action, input.value);
      }
      case "pointer": {
        if (this.overlay?.members.has(surface.id)) return;
        const parsed = pointerEvent.safeParse(input.event);
        if (!parsed.success)
          throw new AppError("permissionDenied", "Invalid desktop pointer event");
        const e = parsed.data;
        if (!surface.cards.some((c) => c.id === e.cardId) || !this.isCardVisible(e.cardId)) return;
        const card = this.cards.get(e.cardId);
        if (
          !card ||
          card.inputMode !== "interactive" ||
          e.revision !== this.options.store.load().revision
        )
          return;
        if (
          ["enter", "down", "click", "doubleclick", "contextmenu", "wheel"].includes(e.type) &&
          (!contains({ x: 0, y: 0, width: card.bounds.width, height: card.bounds.height }, e) ||
            (card.clip && !contains(card.clip, e)))
        )
          return;
        await this.consumers
          .get(card.consumerId!)
          ?.onPointer?.({ ...e, screenX: card.bounds.x + e.x, screenY: card.bounds.y + e.y });
        return;
      }
      case "edit-pointer": {
        if (
          !this.editor ||
          this.editor.id !== input.editSession ||
          !this.options.cursor ||
          !surface.window.win.isVisible() ||
          !surface.cards.some((card) => card.id === input.cardId && card.renderKind !== "notes") ||
          !Number.isSafeInteger(input.pointerId) ||
          input.pointerId < 0
        )
          throw new AppError("permissionDenied", "Desktop edit pointer is unavailable");
        if (input.phase === "start") {
          if (this.editGesture || !["move", "resize"].includes(input.mode ?? ""))
            throw new AppError("layer.pointerBusy", "Another desktop gesture is active");
          const card = this.cards.get(input.cardId)!;
          // Capture the down point in the trusted shell. A fast native drag may
          // already be at its end before this IPC is dispatched; move/up still
          // sample the native cursor in global DIPs to cross DPI boundaries.
          const clientPoint = z
            .strictObject({ x: coordinate, y: coordinate })
            .parse(input.clientPoint);
          const area = surface.window.win.getBounds();
          const bounds = this.editBounds.get(card.id) ?? card.bounds;
          const cursor = { x: area.x + clientPoint.x, y: area.y + clientPoint.y };
          if (
            !contains({ x: 0, y: 0, width: area.width, height: area.height }, clientPoint) ||
            !contains(
              {
                x: bounds.x - 8,
                y: bounds.y - 8,
                width: bounds.width + 16,
                height: bounds.height + 16,
              },
              cursor,
            )
          )
            throw new AppError(
              "permissionDenied",
              "Desktop gesture started outside its host handle",
            );
          this.editGesture = {
            surfaceId: surface.id,
            cardId: card.id,
            pointerId: input.pointerId,
            mode: input.mode!,
            cursor,
            bounds: this.editBounds.get(card.id) ?? { ...card.bounds },
            latest: this.editBounds.get(card.id) ?? { ...card.bounds },
          };
          return { bounds: this.editGesture.latest };
        }
        const gesture = this.editGesture;
        if (
          !gesture ||
          gesture.surfaceId !== surface.id ||
          gesture.cardId !== input.cardId ||
          gesture.pointerId !== input.pointerId
        )
          throw new AppError("layer.pointerExpired", "Desktop gesture expired");
        if (input.phase === "cancel") {
          this.editGesture = undefined;
          for (const item of this.surfaces.values())
            this.send(item.id, { type: "edit-preview", cardId: gesture.cardId });
          return { bounds: gesture.bounds };
        }
        if (input.phase !== "move" && input.phase !== "end")
          throw new AppError("permissionDenied", "Unknown desktop gesture phase");
        const cursor = this.options.cursor(),
          dx = cursor.x - gesture.cursor.x,
          dy = cursor.y - gesture.cursor.y;
        if (![cursor.x, cursor.y, dx, dy].every(Number.isFinite))
          throw new AppError("layer.pointerExpired", "Native desktop cursor is unavailable");
        const snap = (position: number) => Math.round(position / 8) * 8;
        gesture.latest =
          gesture.mode === "move"
            ? { ...gesture.bounds, x: snap(gesture.bounds.x + dx), y: snap(gesture.bounds.y + dy) }
            : {
                ...gesture.bounds,
                width: Math.max(80, snap(gesture.bounds.width + dx)),
                height: Math.max(32, snap(gesture.bounds.height + dy)),
              };
        if (input.phase === "end") {
          this.editGesture = undefined;
          this.previewLayout([{ cardId: gesture.cardId, patch: { bounds: gesture.latest } }]);
          gesture.latest = this.editor.layout.cards[gesture.cardId].bounds;
          this.editBounds.set(gesture.cardId, gesture.latest);
        }
        for (const item of this.surfaces.values()) {
          if (input.phase === "end")
            this.send(item.id, { type: "edit-preview", cardId: gesture.cardId });
          else if (item.id !== surface.id)
            this.send(item.id, {
              type: "edit-preview",
              cardId: gesture.cardId,
              bounds: gesture.latest,
              title: (this.cards.get(gesture.cardId) as LayerRenderCard | undefined)?.title,
            });
        }
        return { bounds: gesture.latest };
      }
      case "layout-commit": {
        if (
          !this.editor ||
          this.editor.id !== input.editSession ||
          input.expectedRevision !== this.editor.revision
        )
          throw new AppError("layer.layoutConflict", "Desktop layout changed");
        const mutations = z.array(mutation).min(1).max(64).parse(input.mutations);
        if (mutations.some((m) => !this.cards.has(m.cardId)))
          throw new AppError("permissionDenied", "Unknown desktop card");
        this.previewLayout(mutations);
        return;
      }
      case "edit-end":
        return this.endEdit(input.editSession, input.apply);
      case "widget-invoke": {
        if (
          !this.isCardVisible(input.cardId) ||
          !surface.cards.some((c) => c.id === input.cardId) ||
          typeof input.actionId !== "string" ||
          input.actionId.length > 80
        )
          throw new AppError("permissionDenied", "Widget action unavailable");
        const binding = this.cards.get(input.cardId)?.widget;
        const captured = binding ? structuredClone(binding) : undefined;
        const result = await this.onAction?.(
          input.cardId,
          input.actionId,
          input.input,
          input.userGesture === true,
        );
        const current = this.cards.get(input.cardId)?.widget;
        if (
          this.surfaces.get(surface.id) !== surface ||
          !this.isCardVisible(input.cardId) ||
          (captured ? !current || !sameWidgetBinding(captured, current) : !!current)
        )
          throw new AppError("permissionDenied", "Desktop action identity expired");
        return result;
      }
      case "notes-invoke": {
        const card = this.cards.get(input.cardId);
        if (
          !card ||
          card.renderKind !== "notes" ||
          !this.options.flags().notesEnabled ||
          !this.isCardVisible(card.id) ||
          this.editor ||
          !surface.cards.some((item) => item.id === card.id) ||
          typeof input.command !== "string" ||
          input.command.length > 80 ||
          !input.args ||
          typeof input.args !== "object" ||
          Array.isArray(input.args)
        )
          throw new AppError("permissionDenied", "Trusted notes surface is unavailable");
        if (
          this.overlay?.members.has(surface.id) &&
          ["capsule_drag_start", "capsule_drag_end", "capsule_scroll"].includes(input.command)
        )
          throw new AppError("permissionDenied", "插件栏拖动仅调整插件栏位置");
        return this.consumers
          .get(card.consumerId!)
          ?.onInvoke?.(
            card.id,
            input.command,
            input.args,
            this.overlay?.members.has(surface.id)
              ? { bounds: surface.cards.find((item) => item.id === card.id)!.bounds }
              : undefined,
          );
      }
      case "screenshot-invoke": {
        const card = this.cards.get(input.cardId);
        if (
          !card ||
          card.renderKind !== "screenshot" ||
          (card.inputMode !== "interactive" && !this.overlay?.members.has(surface.id)) ||
          !this.isCardVisible(card.id) ||
          this.editor ||
          !surface.cards.some((item) => item.id === card.id)
        )
          throw new AppError("permissionDenied", "Screenshot surface is unavailable");
        const action = z.enum(["edit", "close", "hide", "pin", "zoom", "fit"]).parse(input.action);
        if (action !== "zoom" && input.value !== undefined)
          throw new AppError("permissionDenied", "Screenshot action does not accept a value");
        const args =
          action === "zoom"
            ? { value: z.number().finite().min(0.25).max(4).parse(input.value) }
            : {};
        const consumer = this.consumers.get(card.consumerId!);
        if (!consumer?.onInvoke)
          throw new AppError("permissionDenied", "Screenshot owner is unavailable");
        return consumer.onInvoke(card.id, action, args);
      }
      case "widget-confirm-open": {
        if (
          this.editor ||
          surface.cards.length !== 1 ||
          surface.cards[0].renderKind !== "web" ||
          surface.cards[0].id !== input.cardId ||
          typeof input.candidateId !== "string" ||
          input.candidateId.length > 128 ||
          typeof input.allow !== "boolean" ||
          input.userGesture !== true
        )
          throw new AppError("permissionDenied", "A trusted card confirmation is required");
        return this.onConfirmOpen?.(surface.id, input.cardId, input.candidateId, input.allow);
      }
      case "widget-relay":
        if (surface.cards.length !== 1 || surface.cards[0].renderKind !== "web" || this.editor)
          throw new AppError("permissionDenied", "Widget relay unavailable");
        return this.onRelay?.(surface.id, input.binding, input.wire);
      case "fault":
        this.recover(surface.id, "renderer-logic", new Error(String(input.message).slice(0, 512)));
        return;
      default:
        throw new AppError("permissionDenied", "Unknown desktop request");
    }
  }
  send(id: string, event: LayerEvent): void {
    const s = this.surfaces.get(id);
    if (s && !s.window.win.isDestroyed() && s.window.ready)
      s.window.win.webContents.send("spark233:layer-event", event);
  }
  private previewLayout(mutations: readonly LayerMutation[]): void {
    if (!this.editor) throw new AppError("layer.editExpired", "Desktop editing session expired");
    const displays = this.options.displays();
    if (!displays.length)
      throw new AppError("layer.displayUnavailable", "No desktop display is available");
    const placements = mutations.map(({ cardId, patch }) => {
      const old = this.editor!.layout.cards[cardId];
      if (!old) throw new AppError("permissionDenied", "Unknown desktop card");
      if (!patch.bounds) return { cardId, patch };
      const center = {
        x: patch.bounds.x + patch.bounds.width / 2,
        y: patch.bounds.y + patch.bounds.height / 2,
      };
      const distance = ({ workArea: area }: DisplayArea) =>
        Math.hypot(
          Math.max(area.x - center.x, 0, center.x - area.x - area.width),
          Math.max(area.y - center.y, 0, center.y - area.y - area.height),
        );
      const target =
        displays.find((display) => contains(display.workArea, center)) ??
        displays.reduce((nearest, display) =>
          distance(display) < distance(nearest) ? display : nearest,
        );
      const normalized = constrainLayerCard(
        { ...old, ...patch, displayId: target.id, workAreaAtSave: { ...target.workArea } },
        displays,
        target.id,
      ).card;
      return {
        cardId,
        patch: {
          ...patch,
          displayId: target.id,
          workAreaAtSave: { ...target.workArea },
          bounds: normalized.bounds,
        },
      };
    });
    this.editor = this.options.store.previewEdit(this.editor.id, placements);
    this.refresh();
  }
  publishData(cardId: string, data: WidgetDataFrame): void {
    const card = this.cards.get(cardId);
    if (!card || !this.isCardVisible(cardId)) return;
    const updated = { ...card, data };
    this.cards.set(cardId, updated);
    // A trusted declarative card can have a desktop view and an operation view.
    // Preserve each view's geometry while broadcasting the one business frame.
    for (const surface of this.surfaces.values()) {
      if (!surface.cards.some((item) => item.id === cardId)) continue;
      surface.cards = surface.cards.map((item) => (item.id === cardId ? { ...item, data } : item));
      this.send(surface.id, { type: "data", cardId, data });
      if (surface.publishedSnapshot)
        surface.publishedSnapshot = {
          ...surface.publishedSnapshot,
          cards: surface.publishedSnapshot.cards.map((item) =>
            item.id === cardId ? { ...item, data: structuredClone(data) } : item,
          ),
        };
    }
  }
  surfaceForCard(cardId: string): string | undefined {
    const overlay = this.overlay && this.surfaces.get(this.overlay.id);
    if (overlay?.cards.some((card) => card.id === cardId)) return overlay.id;
    return [...this.surfaces.values()].find((s) => s.cards.some((c) => c.id === cardId))?.id;
  }
  windowForCard(cardId: string): Electron.BrowserWindow | undefined {
    return this.surfaces.get(this.surfaceForCard(cardId) ?? "")?.window.win;
  }
  isCardReady(cardId: string): boolean {
    const surface = this.surfaces.get(this.surfaceForCard(cardId) ?? "");
    return !!surface && surface.window.ready && !surface.window.win.isDestroyed();
  }
  private cardSurfaceKey(card: LayerCard): string {
    const owner = this.overlay?.owners.get(card.id);
    if (owner) return owner;
    if (this.editor) return surfaceKey({ ...card, group: "top", inputMode: "interactive" });
    if (card.renderKind === "web") return "web:" + card.id;
    const base =
      card.fullscreenAutoHide === false
        ? surfaceKey(card) + ":fullscreen-visible"
        : surfaceKey(card);
    // Desktop interaction projections share their widget identity. Separate
    // distant widget families instead of growing a union back across the screen;
    // notes/screenshots retain their existing shared-window resource budget.
    return card.renderKind === "declarative" && card.transientGeometry && card.widget
      ? "shared:widget-family:" + card.widget.widgetInstanceId
      : base;
  }
  isCardVisible(cardId: string): boolean {
    if (this.disposed || this.editor || !this.options.flags().enabled) return false;
    const card = this.cards.get(cardId);
    const participant = this.overlay?.members.has(this.surfaceForCard(cardId) ?? "");
    if (participant) {
      const surface = this.surfaces.get(this.surfaceForCard(cardId)!);
      return (
        !!surface?.cards.some((c) => c.id === cardId && c.visible) &&
        !!surface.window.ready &&
        !surface.window.win.isDestroyed() &&
        (surface.window.win.isVisible() || !!surface.commit)
      );
    }
    if (
      !card?.visible ||
      (card.fullscreenAutoHide !== false &&
        card.renderKind !== "notes" &&
        card.renderKind !== "screenshot" &&
        this.fullscreen.some((area) =>
          contains(area, {
            x: card.bounds.x + card.bounds.width / 2,
            y: card.bounds.y + card.bounds.height / 2,
          }),
        )) ||
      (card.renderKind === "web" && !this.options.flags().webEnabled) ||
      (card.renderKind === "notes" && !this.options.flags().notesEnabled)
    )
      return false;
    const surface = this.surfaces.get(this.surfaceForCard(cardId) ?? this.cardSurfaceKey(card));
    return (
      !!surface &&
      surface.window.ready &&
      !surface.window.win.isDestroyed() &&
      surface.window.win.isVisible()
    );
  }
  recoverCard(cardId: string, code: string, error: Error): void {
    const card = this.cards.get(cardId);
    if (card) this.recover(this.surfaceForCard(cardId) ?? this.cardSurfaceKey(card), code, error);
  }
  retryCard(cardId: string): void {
    const card = this.cards.get(cardId);
    if (!card || this.disposed) return;
    const key = this.surfaceForCard(cardId) ?? this.cardSurfaceKey(card);
    clearTimeout(this.recovering.get(key)?.timer);
    this.recovering.delete(key);
    const surface = this.surfaces.get(key);
    if (surface) {
      this.surfaces.delete(key);
      surface.commit?.finish(false);
      void surface.window.destroy();
    }
    this.refresh();
  }
  surfaceFailure(cardId: string): "recovering" | "faulted" | undefined {
    const card = this.cards.get(cardId);
    if (!card) return undefined;
    const key = this.surfaceForCard(cardId) ?? this.cardSurfaceKey(card),
      recovery = this.recovering.get(key);
    if (!recovery) return undefined;
    if (recovery.count > 3) return "faulted";
    if (recovery.timer || !this.surfaces.get(key)?.window.ready) return "recovering";
    return undefined;
  }
  windows(): Electron.BrowserWindow[] {
    return [...this.surfaces.values()].map((s) => s.window.win);
  }
  get overlayActive(): boolean {
    return !!this.overlay;
  }
  isOverlayWindow(win: Electron.BrowserWindow): boolean {
    return [...(this.overlay?.members ?? [])].some(
      (id) => this.surfaces.get(id)?.window.win === win,
    );
  }
  hasOverlayFocus(): boolean {
    if (
      this.overlay &&
      [...this.external.values()].some((e) => e.pending || e.participant.focus?.())
    )
      return true;
    return [...(this.overlay?.members ?? [])].some((id) => {
      const s = this.surfaces.get(id);
      return (
        !!s &&
        (!!s.commit || s.window.win.isFocused() || s.window.win.webContents.isDevToolsOpened())
      );
    });
  }
  restackOverlay(): void {
    if (!this.overlay) return;
    // Activating the toolbar host can raise its full-screen HWND above cards.
    // Reapply the operation order after every focus transfer between members.
    this.stackSignature = "";
    this.restack();
    for (const entry of this.external.values()) entry.participant.restack?.();
  }
  private assertOverlaySurface(surface: Surface, epoch: number | undefined, cardId?: string): void {
    const session = this.overlay;
    if (
      !session ||
      epoch !== session.epoch ||
      !session.members.has(surface.id) ||
      !this.options.flags().enabled ||
      !surface.window.ready ||
      !surface.window.win.isVisible() ||
      (cardId !== undefined &&
        surface.id !== session.id &&
        !surface.cards.some((c) => c.id === cardId))
    )
      throw new AppError("permissionDenied", "桌面插件栏会话已失效");
  }
  private async panelAction(
    cardId: string,
    action: "show" | "hide" | "pin" | "passthrough" | "open",
    value?: boolean,
  ): Promise<unknown> {
    const card = this.cards.get(cardId);
    if (!card || !overlayPanelKind(card))
      throw new AppError("permissionDenied", "插件栏面板已失效");
    action = z.enum(["show", "hide", "pin", "passthrough", "open"]).parse(action);
    if (action === "open") {
      if (!this.isCardVisible(card.id) && !this.external.get(card.id)?.value?.visible)
        throw new AppError("permissionDenied", "请先显示面板");
      const consumer = this.consumers.get(card.consumerId!);
      const opening =
        card.renderKind === "notes"
          ? consumer?.onInvoke?.(card.id, "capsule_open", { id: card.renderRef })
          : card.renderKind === "screenshot"
            ? consumer?.onInvoke?.(card.id, "edit", {})
            : card.renderKind === "utools" || card.renderKind === "window"
              ? consumer?.onInvoke?.(card.id, "open", {})
              : this.options.onOverlayOpenPanel?.(card);
      // Release the operation layer before handing focus to an editor or
      // detail window; restoring the old app here would steal that focus.
      await this.closeOverlay(false);
      return opening;
    }
    if (action === "pin" || action === "passthrough") {
      value = z.boolean().parse(value);
      const sourcePatch =
        action === "pin"
          ? { group: value ? ("top" as const) : ("normal" as const) }
          : { inputMode: value ? ("passive" as const) : ("interactive" as const) };
      if (this.external.has(cardId)) {
        await this.external.get(cardId)!.participant.update?.(sourcePatch);
        this.refresh();
        return;
      }
      if (await this.options.onOverlayPresentation?.(card, sourcePatch)) {
        this.overlayLayout.update(overlayPanelKey(card), {
          pinned: undefined,
          passthrough: undefined,
          sourceGroup: undefined,
          sourceInputMode: undefined,
        });
        this.refresh();
        return;
      }
    }
    if (!this.overlay) {
      await this.commit(
        [{ cardId, patch: { visible: action === "show" } }],
        this.options.store.load().revision,
      );
      return;
    }
    const patch =
      action === "show" || action === "hide"
        ? { selected: action === "show" }
        : action === "pin"
          ? {
              pinned: z.boolean().parse(value),
              sourceGroup: this.overlayLayout.get(overlayPanelKey(card))?.sourceGroup ?? card.group,
            }
          : {
              passthrough: z.boolean().parse(value),
              sourceInputMode:
                this.overlayLayout.get(overlayPanelKey(card))?.sourceInputMode ?? card.inputMode,
            };
    this.overlayLayout.update(overlayPanelKey(card), patch);
    if (action === "hide" && this.overlay) {
      this.overlay!.previews.delete(card.id);
      this.overlay!.menus.delete(card.id);
      this.overlay!.drafts.delete(card.id);
      if (this.overlayGesture?.cardId === card.id) this.overlayGesture = undefined;
    }
    this.refresh();
    return;
  }
  private beginPresentation(surface: Surface): void {
    surface.commit?.finish(false);
    surface.window.beginPresentation();
    surface.presentationRevision = ++this.presentationRevision;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const timer = setTimeout(
      () => {
        finish(false);
        this.diagnostic("presentation-timeout", new Error(surface.id));
        if (this.overlay?.members.has(surface.id)) void this.closeOverlay(false);
        else this.recover(surface.id, "presentation-timeout", new Error("Layout commit timed out"));
      },
      surface.window.ready ? 2500 : 6000,
    );
    timer.unref();
    const finish = (ok: boolean) => {
      if (surface.commit?.promise !== promise) return;
      clearTimeout(timer);
      surface.commit = undefined;
      if (ok) {
        surface.window.completePresentation();
        this.restack();
      }
      resolve(ok);
    };
    surface.commit = { promise, finish };
  }
  private async waitPresentations(ids: Iterable<string>): Promise<boolean> {
    return (
      await Promise.all(
        [...ids].map(async (id) => {
          let surface = this.surfaces.get(id);
          while (surface?.commit) {
            const commit = surface.commit;
            const ok = await commit.promise;
            surface = this.surfaces.get(id);
            // A provider refresh can supersede a pending geometry commit.
            // Wait for its replacement instead of revealing the older layout.
            if (!ok && !surface?.commit) return false;
          }
          return true;
        }),
      )
    ).every(Boolean);
  }
  private clampOverlay(bounds: Rect): Rect {
    const area = this.options.displays().find((d) => d.id === this.overlay?.displayId)!.workArea;
    return {
      ...bounds,
      x: Math.max(area.x + 12, Math.min(bounds.x, area.x + area.width - bounds.width - 12)),
      y: Math.max(area.y + 110, Math.min(bounds.y, area.y + area.height - bounds.height - 12)),
    };
  }
  private overlayPanels(): DesktopOverlayPanel[] {
    return [...this.cards.values()].flatMap((card) => {
      const kind = overlayPanelKind(card);
      if (!kind || !card.visible || (kind === "notes" && !this.options.flags().notesEnabled))
        return [];
      const payload = card.payload as { items?: Array<{ title?: string }> } | undefined;
      return [
        {
          cardId: card.id,
          title:
            card.title ??
            payload?.items?.[0]?.title ??
            (kind === "notes" ? "便签" : kind === "traffic" ? "流量监控" : "截图贴图"),
          kind,
          selected: this.overlayLayout.get(overlayPanelKey(card))?.selected !== false,
          pinned: card.group === "top",
          inputMode: card.inputMode,
        },
      ];
    });
  }
  async openOverlay(displayId?: string): Promise<void> {
    await this.overlayClosing;
    if (this.overlay) return;
    if (this.disposed) throw new AppError("layer.disposed", "桌面插件层已退出，请重新启动软件");
    const readError = this.overlayLayout.readError ?? this.options.store.readError;
    if (readError)
      throw new AppError(
        "layer.layoutReadFailed",
        readError instanceof Error ? readError.message : String(readError),
      );
    if (!this.options.flags().enabled)
      throw new AppError("layer.disabled", "请先在设置中开启桌面插件层");
    if (this.editor) throw new AppError("layer.busy", "请先完成桌面布局编辑");
    const displays = this.options.displays();
    const cursor = this.options.cursor?.();
    const display =
      displays.find((d) => d.id === displayId) ??
      displays.find((d) => cursor && contains(d.workArea, cursor)) ??
      displays.find((d) => d.id === this.options.primaryDisplay()) ??
      displays[0];
    if (!display || this.hidden.has("locked") || this.hidden.has("suspend")) return;
    this.cancelConsumerPointers();
    this.reconcile();
    const eligible = this.overlayPanels();
    const shared = [...this.surfaces.values()].filter((s) => !s.id.startsWith("web:"));
    const sources = shared.filter((s) =>
      s.cards.some((c) => eligible.some((p) => p.cardId === c.id)),
    );
    const donor =
      sources.find((s) => s.displayId === display.id && s.window.ready) ??
      sources.find((s) => s.window.ready) ??
      shared.find((s) => s.displayId === display.id && s.window.ready) ??
      shared.find((s) => s.window.ready) ??
      sources[0] ??
      shared[0];
    const id = donor?.id ?? "overlay:" + display.id;
    const session: OverlaySession = {
      id,
      displayId: display.id,
      epoch: ++this.overlayEpoch,
      owners: new Map(
        [...new Set([...sources, ...(donor ? [donor] : [])])].flatMap((s) =>
          s.cards.map((c) => [c.id, s.id] as const),
        ),
      ),
      members: new Set([id]),
      drafts: new Map(),
      previews: new Set(),
      menus: new Set(),
    };
    this.overlay = session;
    this.reconcile();
    const committed = await this.waitPresentations(session.members);
    await this.waitExternalPresentations();
    if (this.overlay !== session) return;
    if (!committed) {
      await this.closeOverlay(false);
      throw new AppError("layer.presentationFailed", "插件栏布局未能完成，已恢复桌面");
    }
    const surface = this.surfaces.get(id);
    if (!surface?.window.ready) {
      await this.closeOverlay(false);
      throw new AppError("layer.presentationFailed", "插件栏窗口未能就绪，已恢复桌面");
    }
    surface.window.win.focus();
    this.restackOverlay();
  }
  closeOverlay(restoreFocus = true): Promise<void> {
    if (!this.overlay) return this.overlayClosing ?? Promise.resolve();
    const session = this.overlay;
    this.overlay = undefined;
    this.overlayGesture = undefined;
    this.cancelConsumerPointers();
    this.reconcile();
    const closing = (async () => {
      await this.waitPresentations(session.members);
      await this.waitExternalPresentations();
      if (this.overlayEpoch === session.epoch && !this.overlay)
        await this.options.onOverlayClosed?.(restoreFocus);
    })().catch((error) => this.diagnostic("overlay-focus", error));
    this.overlayClosing = closing;
    return closing;
  }
  card(id: string): LayerCard | undefined {
    return this.cards.get(id);
  }
  async beginEdit(_displayId?: string): Promise<string> {
    await this.closeOverlay(false);
    if (!this.options.flags().enabled)
      throw new AppError("layer.disabled", "Enable desktop cards first");
    if (this.editor) return this.editor.id;
    this.cancelConsumerPointers();
    this.reconcile();
    if (
      !this.options.displays().length ||
      ![...this.cards.values()].some(
        (card) =>
          card.renderKind !== "notes" &&
          (card.renderKind !== "web" || this.options.flags().webEnabled),
      )
    )
      throw new AppError("layer.noCards", "No desktop cards are available to edit");
    this.editor = this.options.store.beginEdit("host:" + randomUUID());
    this.editBounds.clear();
    this.refresh();
    return this.editor.id;
  }
  async endEdit(id: string, apply: boolean): Promise<void> {
    if (!this.editor || this.editor.id !== id)
      throw new AppError("layer.layoutConflict", "Desktop editing session expired");
    await this.options.store.endEdit(id, apply);
    this.editGesture = undefined;
    this.editBounds.clear();
    this.editor = undefined;
    this.refresh();
  }
  async commit(
    mutations: readonly LayerMutation[],
    expectedRevision: number,
  ): Promise<LayerChange> {
    const state = this.options.store.load();
    if (state.revision !== expectedRevision)
      throw new AppError("layer.layoutConflict", "Desktop layout changed");
    for (const { cardId, patch } of z.array(mutation).min(1).max(64).parse(mutations)) {
      const old = state.cards[cardId];
      if (!old) throw new AppError("layer.card.invalid", "Unknown card");
      state.cards[cardId] = { ...old, ...patch };
    }
    state.revision++;
    await this.options.store.commit(state, expectedRevision);
    const change: LayerChange = {
      revision: state.revision,
      reason: "move",
      cards: [...this.cards.values()],
    };
    for (const consumer of this.consumers.values()) await consumer.onCardsChanged?.(change);
    return change;
  }
  setVisibility(
    reason: "user" | "locked" | "suspend" | "fullscreen",
    hidden: boolean,
    displayId?: string,
  ): void {
    if (hidden && reason !== "fullscreen") this.closeOverlay(false);
    const key = reason + (displayId ? ":" + displayId : "");
    if (hidden) {
      this.cancelConsumerPointers();
      this.hidden.add(key);
    } else this.hidden.delete(key);
    if (hidden && this.editor) void this.endEdit(this.editor.id, false);
    this.refresh();
  }
  setFullscreen(rects: readonly Rect[]): void {
    if (rects.length && JSON.stringify(rects) !== JSON.stringify(this.fullscreen))
      this.cancelConsumerPointers();
    this.fullscreen = rects;
    if (rects.length && this.editor)
      void this.endEdit(this.editor.id, false).catch((error) =>
        this.diagnostic("fullscreen-edit-cancel", error),
      );
    this.refresh();
  }
  /** Persist screen convergence once, including disabled cards, so reconnecting
   * an old display cannot silently pull a user's relocated card back to it. */
  displayChanged(): Promise<void> {
    this.closeOverlay(false);
    this.cancelConsumerPointers();
    const operation = this.screenChanges
      .catch(() => {})
      .then(async () => {
        if (this.disposed) return;
        this.stackSignature = "";
        for (const surface of this.surfaces.values()) {
          surface.window.invalidateGeometry();
          this.send(surface.id, { type: "cancel-pointer", reason: "display-change" });
        }
        this.editGesture = undefined;
        this.editBounds.clear();
        if (this.editor) await this.endEdit(this.editor.id, false);
        const displays = this.options.displays();
        if (!displays.length || this.options.store.readError) {
          this.refresh();
          return;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const state = this.options.store.load();
          let changed = false;
          for (const [id, card] of Object.entries(state.cards)) {
            const normalized = constrainLayerCard(card, displays, this.options.primaryDisplay());
            if (normalized.constrained) {
              state.cards[id] = normalized.card;
              changed = true;
            }
          }
          if (!changed) break;
          try {
            await this.options.store.commit(
              { ...state, revision: state.revision + 1 },
              state.revision,
            );
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              error.code !== "layer.layoutConflict" ||
              attempt === 2
            )
              throw error;
            continue;
          }
          this.reconcile();
          for (const consumer of this.consumers.values())
            await consumer.onCardsChanged?.({
              revision: state.revision + 1,
              reason: "display",
              cards: [...this.cards.values()],
            });
          break;
        }
        this.refresh();
      });
    this.screenChanges = operation;
    return operation;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) this.closeOverlay(false);
    if (!enabled) this.cancelConsumerPointers();
    if (!enabled && this.editor) await this.endEdit(this.editor.id, false);
    await this.options.store.flush();
    this.refresh();
  }
  private recover(id: string, code: string, error: Error): void {
    if (this.disposed) return;
    const participant = this.overlay?.members.has(id);
    this.cancelConsumerPointers();
    this.diagnostic(code, error);
    const s = this.surfaces.get(id);
    if (s) {
      this.surfaces.delete(id);
      s.commit?.finish(false);
      void s.window.destroy();
    }
    const now = Date.now(),
      old = this.recovering.get(id);
    if (old?.timer) return;
    const item = old && now - old.since < 600000 ? old : { count: 0, since: now };
    item.count++;
    this.recovering.set(id, item);
    if (participant) void this.closeOverlay(false);
    if (item.count > 3) {
      this.options.diagnostic("layer.circuitOpen", { surface: id });
      return;
    }
    item.timer = setTimeout(
      () => {
        item.timer = undefined;
        this.refresh();
      },
      [1000, 3000, 10000][item.count - 1],
    );
    item.timer.unref();
  }
  private diagnostic(code: string, error: unknown): void {
    this.options.diagnostic(code, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.closeOverlay(false);
    await this.options.store.flush();
    this.disposed = true;
    clearInterval(this.monitor);
    this.releaseStore();
    for (const r of this.recovering.values()) clearTimeout(r.timer);
    for (const s of this.surfaces.values()) {
      s.commit?.finish(false);
      await s.window.destroy();
    }
    this.surfaces.clear();
    this.external.clear();
    this.consumers.clear();
  }
}
