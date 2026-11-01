import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite } from "./persistence";
import {
  LayerLayoutStore,
  allocateLayerCards,
  constrainLayerCard,
  findLayerPlacement,
  type WidgetLayoutCard,
} from "./layer-layout-store";

const instanceId = "6535b388-900c-4e10-a83d-d7f83c407d09";
const cardId = `widget:${instanceId}`;
const cardGeometry = {
  displayId: "left",
  bounds: { x: -960, y: 540, width: 300, height: 200 },
  workAreaAtSave: { x: -1920, y: 0, width: 1920, height: 1080 },
  group: "top" as const,
  inputMode: "passive" as const,
  order: 0,
  visible: true,
  restore: true,
  createdAt: 1,
};
const card: WidgetLayoutCard = {
  ...cardGeometry,
  kind: "widget",
  pluginId: "example.clock",
  widgetDefinitionId: "clock",
  widgetInstanceId: instanceId,
};
let directory: string;
beforeEach(() => {
  directory = path.resolve("../../local-build/desktop-layer/store-tests", randomUUID());
  fs.mkdirSync(directory, { recursive: true });
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("desktop layout durability and edit ownership", () => {
  it("publishes only durable commits and rejects stale queued writers after I/O failure", async () => {
    const file = path.join(directory, "layout.json");
    let fail = false;
    const store = new LayerLayoutStore({
      file,
      atomicWrite: (target, value) => {
        if (fail) throw new Error("isolated disk failure");
        atomicWrite(target, value);
      },
    });
    const published: number[] = [];
    store.subscribe((state) => published.push(state.revision));
    await store.mergeDefaults({ [cardId]: card });
    const next = store.load();
    next.revision++;
    next.cards[cardId].bounds.x = -800;
    fail = true;
    await expect(store.commit(next, 1)).rejects.toThrow("isolated disk failure");
    expect(store.load().cards[cardId].bounds.x).toBe(-960);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).revision).toBe(1);
    expect(published).toEqual([1]);
    fail = false;
    const concurrent = structuredClone(next);
    concurrent.cards[cardId].bounds.x = -700;
    const writes = await Promise.allSettled([store.commit(next, 1), store.commit(concurrent, 1)]);
    expect(writes.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(new LayerLayoutStore({ file }).load().cards[cardId].bounds.x).toBe(-800);
    expect(published).toEqual([1, 2]);
    const geometry = store.load();
    geometry.revision++;
    geometry.cards[cardId].bounds.x = -100;
    store.schedule(geometry);
    const user = store.load();
    user.revision++;
    user.cards[cardId].bounds.x = -200;
    await store.commit(user, 2);
    await store.flush();
    expect(new LayerLayoutStore({ file }).load().cards[cardId].bounds.x).toBe(-200);
  });

  it("preserves unreadable or future-version layouts instead of replacing them with defaults", async () => {
    const file = path.join(directory, "layout.json"),
      content = '{"version":99,"cards":{"future":"preserve"}}';
    fs.writeFileSync(file, content);
    const store = new LayerLayoutStore({ file });
    expect(store.readError).toBeDefined();
    await expect(store.mergeDefaults({ [cardId]: card })).rejects.toMatchObject({
      code: "layer.layoutUnreadable",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  it("reloads replaced directories without replaying old drafts, geometry or queued writes", async () => {
    const live = path.join(directory, "live"),
      restored = path.join(directory, "restored"),
      file = path.join(live, "layout.json");
    fs.mkdirSync(live);
    fs.mkdirSync(restored);
    const store = new LayerLayoutStore({ file });
    await store.mergeDefaults({ [cardId]: card });
    await store.flush();
    const draft = store.beginEdit("pre-restore");
    store.previewEdit(draft.id, [{ cardId, patch: { bounds: { ...card.bounds, x: -100 } } }]);
    const geometry = store.load();
    geometry.revision++;
    geometry.cards[cardId].bounds.x = -200;
    store.schedule(geometry);
    const stale = store.commit(geometry, 1);
    const replacement = store.load();
    replacement.revision = 17;
    replacement.cards[cardId].bounds.x = -500;
    const content = JSON.stringify(replacement, null, 2);
    fs.writeFileSync(path.join(restored, "layout.json"), content);
    fs.renameSync(live, path.join(directory, "previous"));
    fs.renameSync(restored, live);
    const published: number[] = [];
    store.subscribe((state) => published.push(state.revision));
    const reloading = store.reloadAfterRestore();
    await expect(stale).rejects.toMatchObject({ code: "layer.layoutConflict" });
    await reloading;
    await store.flush();
    expect(store.load()).toEqual(replacement);
    expect(published).toEqual([17]);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    await expect(store.endEdit(draft.id, false)).rejects.toMatchObject({
      code: "layer.editExpired",
    });

    const future = '{"version":99,"preserve":"restored data"}';
    fs.writeFileSync(file, future);
    await store.reloadAfterRestore();
    expect(store.readError).toBeDefined();
    expect(store.load().cards).toEqual({});
    await expect(store.mergeDefaults({ [cardId]: card })).rejects.toMatchObject({
      code: "layer.layoutUnreadable",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(future);

    fs.writeFileSync(file, content);
    await store.reloadAfterRestore();
    expect(store.readError).toBeUndefined();
    const next = store.load();
    next.revision++;
    next.cards[cardId].bounds.x = -400;
    await store.commit(next, 17);
    expect(new LayerLayoutStore({ file }).load().cards[cardId].bounds.x).toBe(-400);
  });

  it("keeps drafts isolated, cancels conflicted sessions and never resurrects explicit removals", async () => {
    const file = path.join(directory, "layout.json"),
      store = new LayerLayoutStore({ file, now: () => 123 });
    await store.mergeDefaults({ [cardId]: card });
    const first = store.beginEdit("surface-a");
    store.previewEdit(first.id, [{ cardId, patch: { bounds: { ...card.bounds, x: -400 } } }]);
    expect(store.load().cards[cardId].bounds.x).toBe(-960);
    const outside = store.load();
    outside.revision++;
    outside.cards[cardId].group = "normal";
    await store.commit(outside, 1);
    await expect(store.endEdit(first.id, true)).rejects.toMatchObject({
      code: "layer.layoutConflict",
    });
    await store.endEdit(first.id, false);
    const second = store.beginEdit("surface-b");
    store.previewEdit(second.id, [{ cardId, patch: { bounds: { ...card.bounds, x: -300 } } }]);
    await store.endEdit(second.id, true);
    await store.mergeDefaults({ [cardId]: card });
    expect(new LayerLayoutStore({ file }).load().cards[cardId].bounds.x).toBe(-300);
    await store.removeWidget(instanceId);
    await store.mergeDefaults({ [cardId]: card });
    const restored = new LayerLayoutStore({ file }).load();
    expect(restored.cards[cardId]).toBeUndefined();
    expect(restored.removedInstances).toEqual([{ id: cardId, removedAt: 123 }]);
  });

  it("maps missing displays once, constrains tiny work areas and defers excess Web instances", async () => {
    const mapped = constrainLayerCard(card, [
      { id: "primary", workArea: { x: 0, y: 0, width: 1280, height: 720 } },
    ]);
    expect(mapped.card.bounds).toEqual({ x: 640, y: 360, width: 300, height: 200 });
    expect(
      constrainLayerCard(mapped.card, [
        { id: "primary", workArea: { x: 0, y: 0, width: 1280, height: 720 } },
      ]).constrained,
    ).toBe(false);
    // A DPI/work-area change keeps the DIP offset on the same display; a
    // disconnected display must stay relocated after persistence and reconnect.
    expect(
      constrainLayerCard(card, [
        { id: "left", workArea: { x: -1536, y: 80, width: 1536, height: 784 } },
      ]).card.bounds,
    ).toEqual({ x: -576, y: 620, width: 300, height: 200 });
    const file = path.join(directory, "display-layout.json"),
      store = new LayerLayoutStore({ file });
    await store.mergeDefaults({ [cardId]: card });
    const detached = store.load();
    detached.cards[cardId] = mapped.card;
    await store.commit({ ...detached, revision: detached.revision + 1 }, detached.revision);
    const reconnected = new LayerLayoutStore({ file }).load().cards[cardId];
    expect(
      constrainLayerCard(reconnected, [
        { id: "left", workArea: card.workAreaAtSave },
        { id: "primary", workArea: { x: 0, y: 0, width: 1280, height: 720 } },
      ]).card,
    ).toEqual(reconnected);
    expect(
      constrainLayerCard(
        card,
        [{ id: "tiny", workArea: { x: 0, y: 0, width: 100, height: 40 } }],
        "tiny",
        { min: { width: 180, height: 72 } },
      ).card.bounds,
    ).toEqual({ x: 0, y: 0, width: 100, height: 40 });
    expect(
      findLayerPlacement(
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 0, y: 0, width: 500, height: 300 },
        [{ x: 0, y: 0, width: 100, height: 50 }],
      ),
    ).toEqual({ x: 0, y: 58, width: 100, height: 50 });
    const allocation = allocateLayerCards(
      [
        { id: "web-a", card, renderKind: "web" },
        { id: "web-b", card: { ...card, createdAt: 2 }, renderKind: "web" },
        { id: "plain", card: { ...card, createdAt: 3 }, renderKind: "declarative" },
      ],
      { perPlugin: 3, webPerPlugin: 1, perDisplay: 3, webPerDisplay: 1, total: 3, webTotal: 1 },
    );
    expect(allocation.active).toEqual(["web-a", "plain"]);
    expect(allocation.suspended).toEqual({ "web-b": "layer.quotaExceeded" });
    // Trusted screenshot views own a separate plugin budget from notes, while
    // both still consume the same display/global slots.
    const screenshotId = "2b3db7c5-3bc9-4544-b2ac-ae8a8f5c544d";
    const secondScreenshotId = "51c03de4-ea59-4c4e-af26-bf2fb8c96fa7";
    const screenshot = {
      ...cardGeometry,
      kind: "screenshot" as const,
      screenshotId,
    };
    const mixed = allocateLayerCards(
      [
        {
          id: "notes:one",
          card: { ...cardGeometry, kind: "notes", noteId: "one", createdAt: 0 },
          renderKind: "notes",
        },
        { id: `screenshot:${screenshotId}`, card: screenshot, renderKind: "screenshot" },
        {
          id: `screenshot:${secondScreenshotId}`,
          card: { ...screenshot, screenshotId: secondScreenshotId, createdAt: 2 },
          renderKind: "screenshot",
        },
      ],
      { perPlugin: 1, webPerPlugin: 1, perDisplay: 3, webPerDisplay: 1, total: 3, webTotal: 1 },
    );
    expect(mixed.active).toEqual(["notes:one", `screenshot:${screenshotId}`]);
    expect(mixed.suspended).toEqual({
      [`screenshot:${secondScreenshotId}`]: "layer.quotaExceeded",
    });
  });
});
