import type { LayerCard, LayerInputMode } from "./layer-contract.js";
import type { Rect } from "../src/features/capsules/types.js";

/** Host-owned projection of an existing compatibility window. No plugin page
 * or preload receives this control channel. */
export interface UToolsDesktopPresentation {
  revision: number;
  mode: "desktop" | "overlay";
  card: LayerCard;
  area: Rect;
  visible: boolean;
  locale: string;
  epoch?: number;
  /** A trusted host menu/dialog owns all input until it is dismissed. */
  inputBlocked?: boolean;
  deferReveal?: boolean;
  featureCode?: string;
  /** Host management request to focus this already presented window. */
  activate?: boolean;
}
export type UToolsDesktopRequest =
  | { type: "ordinary-close" }
  | { type: "ordinary-topmost"; value: boolean }
  | { type: "ordinary-bounds"; bounds: Rect }
  | { type: "pin"; bounds: Rect; featureCode: string }
  | { type: "unpin" }
  | { type: "focus"; focused: boolean }
  | { type: "close-overlay"; revision: number }
  | {
      type: "bounds";
      revision: number;
      bounds: Rect;
    }
  | {
      type: "panel";
      revision: number;
      action: "show" | "hide" | "pin" | "passthrough" | "open" | "close";
      value?: boolean;
    };
export interface ExternalLayerPresentation {
  mode: "desktop" | "overlay";
  card: LayerCard;
  area: Rect;
  visible: boolean;
  locale: string;
  epoch?: number;
  inputBlocked?: boolean;
  /** Prepare geometry now; the host reveals the ready group together. */
  deferReveal?: boolean;
}
export interface ExternalLayerParticipant {
  present(value: ExternalLayerPresentation): Promise<void>;
  reveal?(): void | Promise<void>;
  focus?(): boolean;
  activate?(): void | Promise<void>;
  restack?(): void;
  update?(patch: { group?: "normal" | "top"; inputMode?: LayerInputMode }): Promise<void>;
}
