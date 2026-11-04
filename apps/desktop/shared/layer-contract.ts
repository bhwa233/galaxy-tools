import type { Rect } from "../src/features/capsules/types.js";
import type {
  DeclarativeTemplate,
  JsonValue,
  WidgetBinding,
  WidgetDataFrame,
  WidgetInit,
} from "@spark233/sdk";

// The optional business fields keep existing trusted capsule geometry consumers
// compatible. Published renderer cards use the explicit LayerRenderCard below.
export type SurfaceKey = string;
export type LayerGroup = "normal" | "top";
export type LayerInputMode = "passive" | "interactive";
export type LayerScreenshotAction = "edit" | "close" | "hide" | "pin" | "zoom" | "fit";
export interface LayerScreenshotImage {
  /** A surface-bound private image handle, never an arbitrary local path. */
  imageUrl: string;
  pixelWidth: number;
  pixelHeight: number;
  editable: boolean;
}
export interface LayerCard {
  id: string;
  title?: string;
  displayId: string;
  group: LayerGroup;
  inputMode: LayerInputMode;
  bounds: Rect;
  /** Visible region relative to bounds' origin, in DIP (not screen coordinates). */
  clip?: Rect;
  order: number;
  visible: boolean;
  consumerId?: string;
  widget?: WidgetBinding;
  renderKind?: "notes" | "declarative" | "web" | "screenshot";
  renderRef?: string;
  payload?: JsonValue;
  screenshot?: LayerScreenshotImage;
  /** Trusted consumer owns temporary drag/edge projections; never persist these bounds. */
  transientGeometry?: boolean;
  /** Preview cards are excluded from layout editing and durable instance management. */
  presentationOnly?: boolean;
  /** Trusted declarative content reports its natural height to the host. */
  intrinsicHeight?: boolean;
  /** Host-owned interaction regions for a reused operation window. */
  overlayControls?: Rect;
  overlayPreview?: Rect;
  hover?: { template: DeclarativeTemplate; size: { width: number; height: number } };
  fullscreenAutoHide?: boolean;
  desktopInteractive?: boolean;
  /** Keeps the source HWND/capture alive while a passive drag projection moves. */
  presentationHidden?: boolean;
}

export interface DisplayArea {
  id: string;
  workArea: Rect;
  scaleFactor: number;
}
export type LayerInstanceStatus = "active" | "hidden" | "suspended" | "orphan" | "fault";
export interface LayerRenderCard extends Omit<LayerCard, "widget"> {
  title?: string;
  consumerId: string;
  renderKind: "notes" | "declarative" | "web" | "screenshot";
  renderRef: string;
  widget?: Pick<
    WidgetBinding,
    "pluginId" | "widgetDefinitionId" | "widgetInstanceId" | "loadGeneration"
  >;
  template?: DeclarativeTemplate;
  data?: WidgetDataFrame;
  images?: Record<string, string>;
  status?: LayerInstanceStatus;
  reason?: string;
}
export interface LayerSnapshot {
  protocol: 1;
  surfaceId: string;
  surfaceGeneration: number;
  revision: number;
  theme: "light" | "dark";
  locale: string;
  scaleFactor: number;
  bounds?: Rect;
  editing: boolean;
  editSession?: string;
  cards: readonly LayerRenderCard[];
  overlay?: DesktopOverlayState;
  /** A native viewport transition is revealed after this layout is committed. */
  presentationRevision?: number;
}
export interface DesktopOverlayPanel {
  cardId: string;
  title: string;
  kind: "notes" | "traffic" | "screenshot";
  selected: boolean;
  pinned: boolean;
  inputMode: LayerInputMode;
}
export interface DesktopOverlayState {
  displayId: string;
  panels: DesktopOverlayPanel[];
  epoch?: number;
  host?: boolean;
  workArea?: Rect;
}
export interface LayerPointerEvent {
  cardId: string;
  revision: number;
  pointerId: number;
  type:
    | "enter"
    | "leave"
    | "down"
    | "move"
    | "up"
    | "cancel"
    | "click"
    | "doubleclick"
    | "contextmenu"
    | "wheel";
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  buttons: number;
  button: "left" | "right" | "middle" | "none";
  deltaX?: number;
  deltaY?: number;
  modifiers: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };
  cancelledBy?: "capture-lost" | "display-change" | "hidden" | "disposed";
}
export interface LayerChange {
  revision: number;
  reason: "move" | "resize" | "group" | "visibility" | "display" | "migration";
  cards: readonly LayerCard[];
}
export interface LayerConsumer {
  readonly id: string;
  snapshot(): readonly LayerCard[];
  onCardsChanged?(change: LayerChange): Promise<void> | void;
  onPointer?(event: LayerPointerEvent): Promise<void> | void;
  onContentHeight?(cardId: string, height: number): void;
  /** Host presentation boundaries cancel trusted consumers' transient capture. */
  onPointersCancelled?(): void;
  onInvoke?(
    cardId: string,
    command: string,
    args: Record<string, unknown>,
    presentation?: { bounds: Rect },
  ): Promise<unknown> | unknown;
  onDispose?(): Promise<void> | void;
}
export interface LayerMutation {
  cardId: string;
  patch: Partial<Pick<LayerCard, "displayId" | "group" | "bounds" | "order" | "visible">>;
}
export type LayoutMutation = readonly LayerMutation[];
type OverlayClientRequest = (
  | { type: "overlay-close" }
  | { type: "overlay-settings" }
  | {
      type: "overlay-panel";
      cardId: string;
      action: "show" | "hide" | "pin" | "passthrough" | "open";
      value?: boolean;
    }
  | { type: "overlay-layout"; cardId: string; bounds: Rect }
  | { type: "overlay-preview"; cardId: string; visible: boolean; region?: "menu" | "preview" }
  | {
      type: "overlay-pointer";
      cardId: string;
      pointerId: number;
      phase: "start" | "move" | "end" | "cancel";
      clientPoint?: { x: number; y: number };
    }
) & { overlayEpoch?: number };
export type LayerClientRequest =
  | OverlayClientRequest
  | { type: "presentation-committed"; revision: number }
  | { type: "ready" }
  | { type: "heartbeat"; lastRevision: number }
  | { type: "content-height"; cardId: string; height: number }
  | { type: "pointer"; event: LayerPointerEvent }
  | {
      type: "layout-commit";
      mutations: LayoutMutation;
      expectedRevision: number;
      editSession: string;
    }
  | { type: "edit-end"; editSession: string; apply: boolean }
  | {
      type: "edit-pointer";
      editSession: string;
      cardId: string;
      pointerId: number;
      phase: "start" | "move" | "end" | "cancel";
      mode?: "move" | "resize";
      clientPoint?: { x: number; y: number };
    }
  | { type: "notes-invoke"; cardId: string; command: string; args: Record<string, unknown> }
  | {
      type: "screenshot-invoke";
      cardId: string;
      action: LayerScreenshotAction;
      value?: number;
    }
  | { type: "widget-relay"; binding: WidgetBinding; wire: string }
  | { type: "widget-invoke"; cardId: string; actionId: string; input?: JsonValue }
  | { type: "widget-confirm-open"; cardId: string; candidateId: string; allow: boolean }
  | { type: "fault"; cardId?: string; code: string; message: string };
export type LayerRequest = LayerClientRequest & {
  protocol: 1;
  surfaceId: string;
  surfaceGeneration: number;
  seq: number;
};
export type LayerEvent =
  | { type: "snapshot"; snapshot: LayerSnapshot }
  | {
      type: "geometry";
      surfaceGeneration: number;
      revision: number;
      /** Local native viewport origin moves with compact shared widget windows. */
      bounds?: Rect;
      cards: readonly { cardId: string; bounds: Rect }[];
    }
  | { type: "data"; cardId: string; data: WidgetDataFrame }
  | {
      type: "widget-init";
      binding: WidgetBinding;
      url: string;
      nonce: string;
      init: WidgetInit;
      initialWire: string;
    }
  | { type: "widget-wire"; wire: string }
  | {
      type: "widget-open-main";
      cardId: string;
      candidateId: string;
      widgetInstanceId: string;
      loadGeneration: number;
      title: string;
      label: string;
      dismissLabel: string;
      expiresAt: number;
    }
  | { type: "widget-open-main-cleared"; candidateId: string }
  | { type: "cancel-pointer"; cardId?: string; reason: string }
  | { type: "edit-state"; editing: boolean; editSession?: string }
  | { type: "edit-preview"; cardId: string; bounds?: Rect; title?: string };
export interface LayerClient {
  request(request: LayerClientRequest): Promise<unknown>;
  subscribe(listener: (event: LayerEvent) => void): () => void;
}
export interface LayerTemplateSummary {
  pluginId: string;
  widgetDefinitionId: string;
  title: string;
  kind: "web" | "declarative";
  quota: { active: number; limit: number };
}
export interface LayerInstanceSummary {
  title?: string;
  widgetInstanceId: string;
  pluginId: string;
  widgetDefinitionId: string;
  displayId: string;
  visible: boolean;
  group?: LayerGroup;
  inputMode?: LayerInputMode;
  bounds?: Rect;
  status: LayerInstanceStatus;
  reason?: string;
}
export interface LayerManagementState {
  notesMigrationError?: string;
  templates: LayerTemplateSummary[];
  instances: LayerInstanceSummary[];
}
declare global {
  interface Window {
    spark233Layer?: LayerClient;
  }
}
