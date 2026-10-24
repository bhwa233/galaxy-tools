import { describe, it, expect } from "vitest";
import {
  insertMembers,
  members,
  nearestEdge,
  pillWidth,
  previewGeometry,
  queueGeometry,
  PILL_MAX_WIDTH,
  intersectRect,
  queueInsertionIndex,
  previewCorridor,
  contains,
} from "./capsule-layout";
import type { CapsuleEntry } from "../src/features/capsules/types";
const area = { x: -1920, y: 120, width: 1920, height: 960 };
function entry(id: string, order: number, visible = true): CapsuleEntry {
  return {
    label: id,
    noteId: id,
    visible,
    folded: true,
    bounds: { x: 50, y: 50, width: 360, height: 420 },
    capsule: { kind: "docked", displayId: "a", edge: "left", order, x: 0, y: 0 },
  };
}
describe("capsule placement and queue ownership", () => {
  it("chooses edges and constrains previews in a monitor with a negative origin", () => {
    expect(nearestEdge({ id: "a", workArea: area }, { x: -1800, y: 400 })).toBe("left");
    const preview = previewGeometry(area, { x: -52, y: 1000, width: 52, height: 32 }, "right");
    expect(preview.x).toBeGreaterThanOrEqual(area.x);
    expect(preview.x + preview.width).toBeLessThanOrEqual(0);
    expect(preview.y + preview.height).toBeLessThanOrEqual(1080);
  });
  it("recognizes the top edge without changing left and right docking", () => {
    const display = { id: "a", workArea: area };
    expect(nearestEdge(display, { x: -960, y: 130 })).toBe("top");
    expect(nearestEdge(display, { x: -1910, y: 650 })).toBe("left");
    expect(nearestEdge(display, { x: -10, y: 650 })).toBe("right");
  });
  it("centers a top queue, keeps every pill on one row and clamps a manual anchor", () => {
    const queue = { key: "a:top", offset: 0, collapsed: false, scroll: 0, centered: true };
    const g = queueGeometry(area, "top", queue, [160, 120, 96]);
    expect(g.bounds.y).toBe(area.y);
    expect(g.bounds.x + g.bounds.width / 2).toBe(area.x + area.width / 2);
    expect(g.master.x).toBe(0);
    for (let i = 0; i < 3; i++) expect(g.slot(i).y).toBe(g.master.y);
    expect(g.slot(0).x).toBeGreaterThan(g.master.width);
    expect(g.slot(1).x).toBeGreaterThan(g.slot(0).x + g.slot(0).width);
    const manual = queueGeometry(
      area,
      "top",
      { ...queue, centered: false, offset: 5000 },
      [160, 120, 96],
    );
    expect(manual.bounds.x + manual.bounds.width).toBe(area.x + area.width);
  });
  it("scrolls a top queue behind its fixed master with matching visible hit regions", () => {
    const narrow = { x: -500, y: -300, width: 500, height: 800 };
    const queue = { key: "a:top", offset: 0, collapsed: false, scroll: 100, centered: true };
    const g = queueGeometry(narrow, "top", queue, [160, 160, 160, 160]);
    expect(g.bounds.width).toBe(narrow.width);
    expect(g.master.x).toBe(0);
    const visible = intersectRect(g.slot(0), g.viewport)!;
    expect(visible.x).toBe(g.viewport.x);
    expect(visible.width).toBeLessThan(g.slot(0).width);
    expect(visible.x).toBeGreaterThan(g.master.x + g.master.width);
    const collapsed = queueGeometry(
      narrow,
      "top",
      { ...queue, collapsed: true },
      [160, 160, 160, 160],
    );
    expect(collapsed.scroll).toBe(g.scroll);
    expect(collapsed.bounds.width).toBe(collapsed.master.width);
    expect(intersectRect(g.slot(0), { ...g.viewport, x: 1000 })).toBeUndefined();
  });
  it("places top previews below their capsule and retains only the gap during hover", () => {
    const anchor = { x: -200, y: area.y, width: 160, height: 32 };
    const preview = previewGeometry(area, anchor, "top");
    expect(preview.y).toBeGreaterThan(anchor.y + anchor.height);
    expect(preview.x).toBeGreaterThanOrEqual(area.x);
    expect(preview.x + preview.width).toBeLessThanOrEqual(area.x + area.width);
    expect(preview.y + preview.height).toBeLessThanOrEqual(area.y + area.height);
    const corridor = previewCorridor(anchor, preview, "top");
    expect(contains(corridor, { x: anchor.x + 50, y: anchor.y + anchor.height + 3 })).toBe(true);
    expect(contains(corridor, { x: anchor.x - 30, y: anchor.y + anchor.height + 3 })).toBe(false);
  });
  it("finds insertion points along the queue's axis for unequal-width pills", () => {
    const g = queueGeometry(
      area,
      "top",
      { key: "a:top", offset: 0, scroll: 0, collapsed: false },
      [160, 96, 120],
    );
    const slots = [0, 1, 2].map((i) => g.slot(i));
    expect(queueInsertionIndex(slots, { x: slots[0].x - 1, y: 0 }, "top")).toBe(0);
    expect(queueInsertionIndex(slots, { x: slots[1].x + 5, y: 0 }, "top")).toBe(1);
    expect(queueInsertionIndex(slots, { x: slots[2].x + slots[2].width, y: 0 }, "top")).toBe(3);
  });
  it("moves members between side and top queues without changing note window bounds", () => {
    const a = entry("a", 0),
      b = entry("b", 1),
      other = entry("other", 2);
    const before = structuredClone([a.bounds, b.bounds, other.bounds]);
    insertMembers([a, b, other], [a, b], "b", "top", 0);
    expect(members([a, b, other], "b:top").map((e) => e.noteId)).toEqual(["a", "b"]);
    expect(members([a, b, other], "a:left").map((e) => e.noteId)).toEqual(["other"]);
    insertMembers([a, b, other], [a], "a", "right", 0);
    expect(a.capsule?.edge).toBe("right");
    expect([a.bounds, b.bounds, other.bounds]).toEqual(before);
  });
  it("keeps the master reachable and scrolls overflowing entries without moving expanded geometry", () => {
    const g = queueGeometry(
      area,
      "right",
      { key: "a:right", offset: 5000, collapsed: false, scroll: 20000 },
      Array<number>(40).fill(PILL_MAX_WIDTH),
    );
    expect(g.bounds.y).toBe(120);
    expect(g.bounds.x + g.bounds.width).toBe(0);
    expect(g.master.y + g.master.height).toBeLessThan(g.bounds.height);
    expect(g.slot(39).y + g.slot(39).height).toBeLessThanOrEqual(g.bounds.height);
    const collapsed = queueGeometry(
      area,
      "left",
      { key: "a:left", offset: 5000, collapsed: true, scroll: 0 },
      [PILL_MAX_WIDTH],
    );
    expect(collapsed.bounds.y + collapsed.bounds.height).toBe(1080);
  });
  it("sizes pills to their labels within the cap and hugs the screen edge", () => {
    expect(pillWidth("")).toBe(96);
    expect(pillWidth("无标题便签")).toBe(122);
    expect(pillWidth("很长的便签标题".repeat(20))).toBe(160);
    const right = queueGeometry(
      area,
      "right",
      { key: "a:right", offset: 100, collapsed: false, scroll: 0 },
      [160, 120, 96],
    );
    expect(right.bounds.width).toBe(160);
    expect(right.bounds.x + right.bounds.width).toBe(0);
    expect(right.slot(0)).toMatchObject({ x: 0, width: 160 });
    expect(right.slot(1)).toMatchObject({ x: 40, width: 120 });
    expect(right.slot(2)).toMatchObject({ x: 64, width: 96 });
    const left = queueGeometry(
      area,
      "left",
      { key: "a:left", offset: 100, collapsed: false, scroll: 0 },
      [120, 160],
    );
    expect(left.bounds.x).toBe(area.x);
    expect(left.bounds.width).toBe(160);
    expect(left.slot(0)).toMatchObject({ x: 0, width: 120 });
  });
  it("reorders and transfers the captured members while leaving hidden notes and paper bounds intact", () => {
    const a = entry("a", 0),
      b = entry("b", 1),
      hidden = entry("hidden", 2, false),
      c = entry("c", 0);
    a.folded = false; // Expanded papers keep their dock entry, hidden papers do not.
    c.capsule!.displayId = "b";
    c.capsule!.edge = "right";
    const all = [a, b, hidden, c],
      before = structuredClone(all.map((e) => e.bounds));
    insertMembers(all, [b], "a", "left", 0);
    expect(members(all, "a:left").map((e) => e.noteId)).toEqual(["b", "a"]);
    insertMembers(all, [b, a], "b", "right", 1);
    expect(members(all, "b:right").map((e) => e.noteId)).toEqual(["c", "b", "a"]);
    expect(hidden.capsule!.displayId).toBe("a");
    expect(all.map((e) => e.bounds)).toEqual(before);
  });
});
