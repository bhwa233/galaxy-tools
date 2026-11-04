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
  featureCode?: string;
}
export type UToolsDesktopRequest =
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
      action: "show" | "hide" | "pin" | "passthrough" | "open";
      value?: boolean;
    };
export interface ExternalLayerPresentation {
  mode: "desktop" | "overlay";
  card: LayerCard;
  area: Rect;
  visible: boolean;
  locale: string;
  epoch?: number;
}
export interface ExternalLayerParticipant {
  present(value: ExternalLayerPresentation): Promise<void>;
  focus?(): boolean;
  restack?(): void;
  update?(patch: { group?: "normal" | "top"; inputMode?: LayerInputMode }): Promise<void>;
}
