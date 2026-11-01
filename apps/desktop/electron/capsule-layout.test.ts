import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { computeShape, LayerWindow } from "./layer-window";
import type { LayerCard } from "../shared/layer-contract";
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
  it("bounds live queue slots without losing the tail when geometry exposes more notes", () => {
    // A larger work area or shorter titles can expose more pills than the
    // shared-layer budget. They must remain scrollable rather than disappearing.
    const spacious = { x: 0, y: 0, width: 1600, height: 1200 };
    const queue = { key: "a:top", offset: 0, collapsed: false, scroll: 1_000_000 };
    const top = queueGeometry(spacious, "top", queue, [160, 96, 160, 96], 2);
    const tail = intersectRect(top.slot(3), top.viewport)!;
    expect(tail.width).toBe(96);
    expect(tail.x + tail.width).toBe(top.viewport.x + top.viewport.width);
    expect(top.bounds.width).toBeLessThan(spacious.width);
    const side = queueGeometry(spacious, "left", queue, [96, 96, 96, 96], 2);
    expect(side.slot(3).y + side.slot(3).height).toBeLessThanOrEqual(side.bounds.height);
    expect(side.slot(3).y).toBeGreaterThanOrEqual(side.viewport.y);
    expect(side.slot(2).y).toBeGreaterThanOrEqual(side.viewport.y);
    expect(side.slot(1).y).toBeLessThan(side.viewport.y);
    const collapsed = queueGeometry(spacious, "top", { ...queue, collapsed: true }, [160, 96], 1);
    expect(collapsed.bounds.width).toBe(collapsed.master.width);
  });
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

describe("layer native hit regions and release", () => {
  const card: LayerCard = {
    id: "clipped",
    displayId: "negative",
    group: "top",
    inputMode: "interactive",
    bounds: { x: -1910.5, y: 100.25, width: 80, height: 80 },
    clip: { x: -5, y: 30.5, width: 30.75, height: 18.5 },
    order: 0,
    visible: true,
  };
  it("intersects card-local clips with screen bounds before converting to outward-rounded client DIP", () => {
    expect(computeShape([card], area)).toEqual([{ x: 9, y: 10, width: 27, height: 20 }]);
    // Crossing the work-area edge must not leave an invisible native hit region.
    expect(
      computeShape([{ ...card, bounds: { x: -1930.5, y: 100.25, width: 80, height: 80 } }], area),
    ).toEqual([{ x: 0, y: 10, width: 16, height: 20 }]);
  });
  it("returns an empty shape for absent, hidden and fully clipped cards", () => {
    expect(computeShape([], area)).toEqual([]);
    expect(
      computeShape(
        [
          { ...card, visible: false },
          { ...card, clip: { x: 100, y: 0, width: 20, height: 20 } },
          { ...card, bounds: { x: 100, y: 100, width: 20, height: 20 } },
        ],
        area,
      ),
    ).toEqual([]);
  });
  it("unions duplicate, overlapping and adjacent rectangles without filling gaps", () => {
    const rectangles = [
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 10, y: 10, width: 20, height: 20 },
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 30, y: 10, width: 10, height: 20 },
    ];
    expect(
      computeShape(
        rectangles.map((bounds) => ({ ...card, bounds, clip: undefined })),
        { x: 0, y: 0, width: 100, height: 100 },
      ),
    ).toEqual([
      { x: 0, y: 0, width: 20, height: 10 },
      { x: 0, y: 10, width: 40, height: 10 },
      { x: 10, y: 20, width: 30, height: 10 },
    ]);
  });
  it("keeps interleaved lock/suspend recovery fenced and cancels late restoration on release", () => {
    vi.useFakeTimers();
    const screen = new EventEmitter(),
      power = new EventEmitter();
    const restored = vi.fn(),
      changed = vi.fn(),
      suppressed = new Set<string>();
    const release = LayerWindow.observeEnvironment({
      screen,
      powerMonitor: power,
      timers: { setTimeout, clearTimeout },
      onDisplayChange: changed,
      onSuppressed: (reason, value) => {
        if (value) suppressed.add(reason);
        else suppressed.delete(reason);
      },
      onRestore: restored,
    });
    try {
      power.emit("lock-screen");
      power.emit("suspend");
      power.emit("unlock-screen");
      vi.advanceTimersByTime(3000);
      expect(restored).not.toHaveBeenCalled();
      expect(suppressed).toEqual(new Set(["locked", "suspend"]));
      power.emit("resume");
      vi.advanceTimersByTime(2000);
      expect(suppressed.size).toBe(0);
      expect(restored).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
      power.emit("lock-screen");
      power.emit("unlock-screen");
      release();
      screen.emit("display-removed");
      power.emit("resume");
      vi.advanceTimersByTime(6000);
      expect(restored).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      vi.useRealTimers();
    }
  });
  it("hides before clearing native hit regions and retires pending loads when destroyed", async () => {
    vi.useFakeTimers();
    let visible = false;
    let actualBounds = { ...area };
    let rejectLoad!: (error: Error) => void;
    const diagnostic = vi.fn(),
      publish = vi.fn();
    const native = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() }),
      setIgnoreMouseEvents: vi.fn(),
      setMenu: vi.fn(),
      setBounds: vi.fn((bounds: typeof area) => {
        actualBounds = { ...bounds };
      }),
      getBounds: () => ({ ...actualBounds }),
      setAlwaysOnTop: vi.fn(),
      loadURL: () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        }),
      isVisible: () => visible,
      showInactive: vi.fn(() => {
        visible = true;
      }),
      hide: vi.fn(() => {
        visible = false;
      }),
      // Electron resets an empty shape to its full window rectangle. It must
      // already be hidden at this native boundary, not merely hidden afterward.
      setShape: vi.fn((shape: unknown[]) => {
        if (!shape.length) expect(visible).toBe(false);
      }),
      destroy: () => {
        visible = false;
        native.emit("closed");
      },
    });
    const layer = new LayerWindow({
      id: "isolated",
      mode: "shared",
      bounds: area,
      group: "top",
      inputMode: "interactive",
      title: "",
      entryURL: "about:blank",
      preloadPath: "",
      label: "isolated",
      screen: { getDisplayMatching: vi.fn() },
      timers: { setTimeout, clearTimeout },
      createBrowserWindow: () => native as unknown as BrowserWindow,
      diagnostic,
      onClosed: vi.fn(),
    });
    try {
      layer.apply([card], area, publish);
      layer.markReady();
      layer.show();
      expect(visible).toBe(true);
      // HUD pointer moves used to repeat unchanged native window operations
      // every frame. Geometry/visibility reuse must retain later OS corrections.
      native.setBounds.mockClear();
      native.setShape.mockClear();
      native.setAlwaysOnTop.mockClear();
      native.showInactive.mockClear();
      // Native region updates may announce resize without changing bounds;
      // those notifications must not invalidate the shape cache in a loop.
      native.emit("resize");
      layer.apply([card], { ...area }, publish);
      layer.apply([card], { ...area }, publish);
      layer.setSuppressed("user", false);
      layer.setFullscreen([]);
      expect(native.setBounds).not.toHaveBeenCalled();
      expect(native.setShape).not.toHaveBeenCalled();
      expect(native.setAlwaysOnTop).not.toHaveBeenCalled();
      expect(native.showInactive).not.toHaveBeenCalled();
      actualBounds = { ...area, x: area.x + 10 };
      native.emit("move");
      layer.apply([card], area, publish);
      expect(actualBounds).toEqual(area);
      native.setBounds.mockClear();
      native.setShape.mockClear();
      layer.invalidateGeometry();
      layer.apply([card], area, publish);
      expect(native.setBounds).toHaveBeenCalledOnce();
      expect(native.setShape).toHaveBeenCalledOnce();
      layer.setFullscreen([area]);
      expect(native.setAlwaysOnTop.mock.lastCall?.[0]).toBe(false);
      expect(visible).toBe(false);
      native.setAlwaysOnTop.mockClear();
      layer.setFullscreen([{ ...area }]);
      expect(native.setAlwaysOnTop).not.toHaveBeenCalled();
      layer.setFullscreenBehavior("lower");
      expect(visible).toBe(true);
      layer.setFullscreen([]);
      expect(native.setAlwaysOnTop.mock.lastCall?.[0]).toBe(true);
      layer.setSuppressed("user", true);
      expect(visible).toBe(false);
      layer.setSuppressed("user", false);
      expect(visible).toBe(true);
      // A fractional negative origin must use one outward-rounded native
      // rectangle for both HWND bounds and client-local hit regions.
      layer.apply([card], { x: -1910.5, y: 100.25, width: 80.4, height: 80.1 }, publish);
      expect(native.setBounds).toHaveBeenLastCalledWith({
        x: -1911,
        y: 100,
        width: 81,
        height: 81,
      });
      layer.apply([], area, publish);
      layer.show();
      expect(visible).toBe(false);
      await layer.destroy();
      rejectLoad(new Error("Load completed after disposal"));
      await Promise.resolve();
      vi.advanceTimersByTime(6000);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(layer.apply([card], area, publish)).toBe(false);
      expect(visible).toBe(false);
    } finally {
      await layer.destroy();
      vi.useRealTimers();
    }
  });
});
