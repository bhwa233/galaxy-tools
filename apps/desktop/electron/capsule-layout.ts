import type { CapsuleEntry, CapsuleQueue, Edge, Rect } from "../src/features/capsules/types.js";
export interface CapsuleDisplay {
  id: string;
  workArea: Rect;
}
export const PILL_MAX_WIDTH = 160;
export const PILL_MIN_WIDTH = 96;
export const PILL_HEIGHT = 32;
export const SLOT_PITCH = 40;
export const PILL_GAP = 8;
const MASTER_MIN_WIDTH = 84;
/** Pills hug the screen edge and grow inward with their label. The 12px label renders
 * CJK/fullwidth glyphs at 12 DIP and others near 6.5; chrome (border, padding, mark, gap)
 * adds 62. The label's ellipsis absorbs estimate drift, so exact font metrics are unneeded. */
export function pillWidth(label: string): number {
  let units = 0;
  for (const ch of label) units += ch.charCodeAt(0) >= 0x2e80 ? 12 : 6.5;
  return Math.max(PILL_MIN_WIDTH, Math.min(PILL_MAX_WIDTH, Math.round(62 + units)));
}
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
  return (["left", "right", "top"] as const).reduce((nearest, edge) =>
    edgeDistance(display.workArea, edge, point) < edgeDistance(display.workArea, nearest, point)
      ? edge
      : nearest,
  );
}
export function edgeDistance(area: Rect, edge: Edge, point: { x: number; y: number }): number {
  if (edge === "top") return Math.abs(point.y - area.y);
  return Math.abs(point.x - (edge === "left" ? area.x : area.x + area.width));
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
/** All geometry uses Electron screen DIPs, including negative monitor origins. */
export function queueGeometry(area: Rect, edge: Edge, queue: CapsuleQueue, widths: number[]) {
  const count = widths.length;
  // Reserve the icons, gaps, padding and edge borders, then grow the count column as needed.
  const masterWidth = Math.max(MASTER_MIN_WIDTH, 62 + String(count).length * 8);
  if (edge === "top") {
    const start = masterWidth + PILL_GAP;
    const ends: number[] = [];
    let totalWidth = start;
    for (const itemWidth of widths) {
      ends.push(totalWidth);
      totalWidth += itemWidth + PILL_GAP;
    }
    const naturalWidth = count ? totalWidth - PILL_GAP : masterWidth;
    totalWidth = queue.collapsed ? masterWidth : naturalWidth;
    const width = Math.min(area.width, totalWidth);
    const scroll = Math.max(0, Math.min(Math.max(0, naturalWidth - area.width), queue.scroll));
    const offset = queue.centered ? (area.width - width) / 2 : queue.offset;
    const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - width, area.x + offset)));
    return {
      bounds: { x, y: area.y, width, height: Math.min(area.height, PILL_HEIGHT) },
      scroll,
      master: { x: 0, y: 0, width: Math.min(width, masterWidth), height: PILL_HEIGHT },
      viewport: { x: start, y: 0, width: Math.max(0, width - start), height: PILL_HEIGHT },
      slot: (index: number) => ({
        x: ends[index] - scroll,
        y: 0,
        width: widths[index],
        height: PILL_HEIGHT,
      }),
    };
  }
  const width = Math.max(PILL_MIN_WIDTH, masterWidth, ...widths);
  const height = Math.min(area.height, SLOT_PITCH * (queue.collapsed ? 1 : count + 1));
  const y = Math.round(
    Math.max(area.y, Math.min(area.y + area.height - height, area.y + queue.offset)),
  );
  const x = Math.round(edge === "left" ? area.x : area.x + area.width - width);
  const maxScroll = Math.max(0, (count + 1) * SLOT_PITCH - height);
  const scroll = Math.max(0, Math.min(maxScroll, queue.scroll));
  return {
    bounds: { x, y, width, height },
    scroll,
    viewport: { x: 0, y: SLOT_PITCH, width, height: Math.max(0, height - SLOT_PITCH) },
    master: {
      x: edge === "left" ? 0 : width - masterWidth,
      y: 2,
      width: masterWidth,
      height: PILL_HEIGHT,
    },
    slot: (index: number) => ({
      x: edge === "left" ? 0 : width - widths[index],
      y: (index + 1) * SLOT_PITCH + 2 - scroll,
      width: widths[index],
      height: PILL_HEIGHT,
    }),
  };
}
/** Native hit regions and renderer clipping must agree on the visible part of a capsule. */
export function intersectRect(rect: Rect, viewport: Rect): Rect | undefined {
  const x = Math.max(rect.x, viewport.x),
    y = Math.max(rect.y, viewport.y);
  const width = Math.min(rect.x + rect.width, viewport.x + viewport.width) - x;
  const height = Math.min(rect.y + rect.height, viewport.y + viewport.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}
export function queueInsertionIndex(
  slots: Rect[],
  point: { x: number; y: number },
  edge: Edge,
): number {
  const index = slots.findIndex((rect) =>
    edge === "top" ? point.x < rect.x + rect.width / 2 : point.y < rect.y + rect.height / 2,
  );
  return index < 0 ? slots.length : index;
}
export function previewGeometry(area: Rect, anchor: Rect, edge: Edge): Rect {
  if (edge === "top") {
    const width = Math.min(380, Math.max(1, area.width - 16));
    const y = anchor.y + anchor.height + 6;
    const height = Math.min(420, Math.max(1, area.y + area.height - y - 8));
    return {
      x: Math.round(
        Math.max(
          area.x + 8,
          Math.min(area.x + area.width - width - 8, anchor.x + anchor.width / 2 - width / 2),
        ),
      ),
      y: Math.round(y),
      width,
      height,
    };
  }
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
export function previewCorridor(anchor: Rect, preview: Rect, edge: Edge): Rect {
  if (edge === "top")
    return {
      x: anchor.x - 4,
      y: anchor.y + anchor.height - 2,
      width: anchor.width + 8,
      height: Math.max(0, preview.y - anchor.y - anchor.height) + 4,
    };
  const x = edge === "left" ? anchor.x + anchor.width : preview.x + preview.width;
  const end = edge === "left" ? preview.x : anchor.x;
  return { x: x - 2, y: anchor.y - 4, width: Math.max(0, end - x) + 4, height: anchor.height + 8 };
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
