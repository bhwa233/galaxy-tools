export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Edge = "left" | "right";
export interface CapsulePlacement {
  kind: "docked" | "floating";
  displayId: string;
  edge: Edge;
  order: number;
  x: number;
  y: number;
}
export interface CapsuleQueue {
  key: string;
  offset: number;
  collapsed: boolean;
  scroll: number;
}
export interface CapsuleEntry {
  label: string;
  noteId?: string;
  visible: boolean;
  folded?: boolean;
  capsule?: CapsulePlacement;
  bounds: Rect;
}
export interface CapsuleItem {
  id: string;
  title: string;
  rect: Rect;
  master?: boolean;
  expanded?: boolean;
  count?: number;
  collapsed?: boolean;
}
export interface CapsuleSnapshot {
  kind: "queue" | "floating" | "preview" | "drag";
  key?: string;
  edge?: Edge;
  items: CapsuleItem[];
  note?: { id: string; title: string; content: string };
  imageBaseDir?: string;
  markdown?: boolean;
}
