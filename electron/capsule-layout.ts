import type { CapsuleEntry, CapsuleQueue, Edge, Rect } from "../src/features/capsules/types.js";
export interface CapsuleDisplay {
  id: string;
  workArea: Rect;
}
export const PILL_WIDTH = 160;
export const PILL_HEIGHT = 32;
export const SLOT_PITCH = 40;
const MASTER_WIDTH = 76;
export function queueKey(displayId: string, edge: Edge): string {
  return `${displayId}:${edge}`;
}
export function contains(rect: Rect, point: { x: number; y: number }, margin = 0): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x < rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y < rect.y + rect.height + margin
  );
}
export function nearestEdge(display: CapsuleDisplay, point: { x: number; y: number }): Edge {
  return point.x - display.workArea.x <= display.workArea.x + display.workArea.width - point.x
    ? "left"
    : "right";
}
export function members(entries: Iterable<CapsuleEntry>, key: string): CapsuleEntry[] {
  return [...entries]
    .filter(
      (e) =>
        e.visible &&
        e.noteId &&
        e.capsule?.kind === "docked" &&
        queueKey(e.capsule.displayId, e.capsule.edge) === key,
    )
    .sort((a, b) => a.capsule!.order - b.capsule!.order || a.label.localeCompare(b.label));
}
/** Screen coordinates are Electron DIPs, including negative monitor origins. No renderer screenX scaling. */
export function queueGeometry(area: Rect, edge: Edge, queue: CapsuleQueue, count: number) {
  const height = Math.min(area.height, SLOT_PITCH * (queue.collapsed ? 1 : count + 1));
  const y = Math.round(
    Math.max(area.y, Math.min(area.y + area.height - height, area.y + queue.offset)),
  );
  const x = Math.round(edge === "left" ? area.x : area.x + area.width - PILL_WIDTH);
  const maxScroll = Math.max(0, (count + 1) * SLOT_PITCH - height);
  const scroll = Math.max(0, Math.min(maxScroll, queue.scroll));
  return {
    bounds: { x, y, width: PILL_WIDTH, height },
    scroll,
    master: {
      x: edge === "left" ? 0 : PILL_WIDTH - MASTER_WIDTH,
      y: 2,
      width: MASTER_WIDTH,
      height: PILL_HEIGHT,
    },
    slot: (index: number) => ({
      x: 0,
      y: (index + 1) * SLOT_PITCH + 2 - scroll,
      width: PILL_WIDTH,
      height: PILL_HEIGHT,
    }),
  };
}
export function previewGeometry(area: Rect, anchor: Rect, edge: Edge): Rect {
  const width = Math.min(380, area.width - anchor.width - 12),
    height = Math.min(420, area.height - 16);
  return {
    x: Math.round(
      Math.max(
        area.x,
        Math.min(
          area.x + area.width - width,
          edge === "left" ? anchor.x + anchor.width + 6 : anchor.x - width - 6,
        ),
      ),
    ),
    y: Math.round(Math.max(area.y + 8, Math.min(area.y + area.height - height - 8, anchor.y - 12))),
    width,
    height,
  };
}
/** One authoritative order per destination; moving a member never rewrites expanded geometry. */
export function insertMembers(
  entries: CapsuleEntry[],
  moving: CapsuleEntry[],
  displayId: string,
  edge: Edge,
  index: number,
) {
  const movingSet = new Set(moving);
  const rest = members(entries, queueKey(displayId, edge)).filter((e) => !movingSet.has(e));
  rest.splice(Math.max(0, Math.min(rest.length, index)), 0, ...moving);
  rest.forEach((entry, order) => {
    entry.capsule = { ...entry.capsule!, kind: "docked", displayId, edge, order };
  });
}
