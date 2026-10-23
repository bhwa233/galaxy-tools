import { describe, it, expect } from "vitest";
import {
  insertMembers,
  members,
  nearestEdge,
  previewGeometry,
  queueGeometry,
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
    expect(nearestEdge({ id: "a", workArea: area }, { x: -1800, y: 200 })).toBe("left");
    const preview = previewGeometry(area, { x: -52, y: 1000, width: 52, height: 32 }, "right");
    expect(preview.x).toBeGreaterThanOrEqual(area.x);
    expect(preview.x + preview.width).toBeLessThanOrEqual(0);
    expect(preview.y + preview.height).toBeLessThanOrEqual(1080);
  });
  it("keeps the master reachable and scrolls overflowing entries without moving expanded geometry", () => {
    const g = queueGeometry(
      area,
      "right",
      { key: "a:right", offset: 5000, collapsed: false, scroll: 20000 },
      40,
    );
    expect(g.bounds.y).toBe(120);
    expect(g.bounds.x + g.bounds.width).toBe(0);
    expect(g.master.y + g.master.height).toBeLessThan(g.bounds.height);
    expect(g.slot(39).y + g.slot(39).height).toBeLessThanOrEqual(g.bounds.height);
    const collapsed = queueGeometry(
      area,
      "left",
      { key: "a:left", offset: 5000, collapsed: true, scroll: 0 },
      40,
    );
    expect(collapsed.bounds.y + collapsed.bounds.height).toBe(1080);
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
