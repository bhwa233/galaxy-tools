import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LayerLayoutStore, type NotesLayoutV2 } from "./layer-layout-store.js";
import { NotesLayerCoordinator } from "./notes-layer.js";
import { atomicWrite } from "./persistence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const initial = (): NotesLayoutV2 => ({
  version: 2,
  windows: [
    {
      label: "notepad-a",
      noteId: "a",
      view: "notepad",
      bounds: { x: -320, y: 55, width: 360, height: 420 },
      visible: true,
      folded: true,
      topmost: true,
      everOpened: true,
      capsule: { kind: "floating", displayId: "left", edge: "top", order: 4, x: -240, y: 22 },
    },
  ],
  capsuleQueues: [{ key: "left:top", offset: 81, scroll: 97, collapsed: false, centered: false }],
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-notes-layer-"));
  roots.push(root);
  const legacyFile = path.join(root, "legacy.json"),
    journalFile = path.join(root, "desktop-layer-migration.json");
  atomicWrite(legacyFile, JSON.stringify(initial()));
  const store = new LayerLayoutStore({ file: path.join(root, "desktop-layout.json") });
  let memory = initial(),
    fail = false,
    mode = false;
  const read = () => JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  const options = {
    store,
    journalFile,
    readLegacy: async () => read(),
    writeLegacy: async (layout: NotesLayoutV2) => {
      if (fail) throw new Error("backend state write refused");
      atomicWrite(legacyFile, JSON.stringify(layout));
    },
    snapshotLegacy: () => structuredClone(memory),
    applyLegacy: (layout: NotesLayoutV2) => {
      memory = layout;
    },
    switchView: async (enabled: boolean) => {
      mode = enabled;
    },
    displays: () => [
      { id: "left", workArea: { x: -1280, y: 0, width: 1280, height: 1024 }, scaleFactor: 1.5 },
    ],
    primaryDisplay: () => "left",
    diagnostic: () => {},
  };
  const coordinator = new NotesLayerCoordinator(options);
  return {
    root,
    store,
    options,
    coordinator,
    read,
    journalFile,
    setMemory: (layout: NotesLayoutV2) => {
      memory = layout;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    mode: () => mode,
  };
}

describe("NotesLayerCoordinator durable migration", () => {
  it("round-trips the latest capsule and queue layout without changing note contents", async () => {
    const f = fixture(),
      body = path.join(f.root, "a.md");
    fs.writeFileSync(body, "正文和附件引用 images/a.png\n");
    await f.coordinator.setEnabled(true);
    expect(f.mode()).toBe(true);
    const latest = initial();
    latest.windows[0].bounds.x = -700;
    latest.windows[0].topmost = false;
    latest.windows[0].visible = false;
    latest.windows[0].capsule!.x = -1110;
    latest.windows[0].capsule!.order = 9;
    latest.capsuleQueues[0].scroll = 221;
    latest.capsuleQueues[0].collapsed = true;
    f.setMemory(latest);
    await f.coordinator.persist(latest);
    await f.coordinator.setEnabled(false);
    expect(f.read()).toEqual(latest);
    expect(f.mode()).toBe(false);
    expect(fs.readFileSync(body, "utf8")).toBe("正文和附件引用 images/a.png\n");
    expect(f.store.load().cards["notes:a"].visible).toBe(false);
    expect(f.store.load().notesCompat?.projectedRevision).toBe(f.store.load().revision);
    expect(fs.existsSync(f.journalFile)).toBe(false);
    await f.coordinator.flush();
    f.coordinator.dispose();
  });

  it("recovers a committed migration after backend failure and never rolls back newer desktop positions", async () => {
    const f = fixture();
    f.fail(true);
    await expect(f.coordinator.setEnabled(true)).rejects.toThrow("backend state write refused");
    expect(f.mode()).toBe(false);
    expect(JSON.parse(fs.readFileSync(f.journalFile, "utf8")).phase).toBe("layer-committed");
    const revision = f.store.load().revision;
    f.fail(false);
    // A process restart reconstructs the coordinator from the actual committed
    // store/journal, while the legacy backend still holds its old copy.
    f.coordinator.dispose();
    const recovered = new NotesLayerCoordinator(f.options);
    await recovered.recover();
    expect(f.store.load().revision).toBe(revision);
    await recovered.setEnabled(true);
    const latest = initial();
    latest.windows[0].capsule!.x = -1000;
    f.fail(true);
    await recovered.persist(latest);
    expect(f.read().windows[0].capsule.x).toBe(-240);
    expect(f.store.load().notesCompat?.windows[0].capsule?.x).toBe(-1000);
    await expect(recovered.setEnabled(false)).rejects.toThrow("backend state write refused");
    expect(recovered.isEnabled).toBe(true);
    expect(f.mode()).toBe(true);
    f.fail(false);
    const readBeforeRecovery = f.read();
    recovered.dispose();
    const restarted = new NotesLayerCoordinator(f.options);
    // Startup reads the backend before loading the journal. That stale read
    // must not be re-imported after recovery has projected newer coordinates.
    const restored = await restarted.restore(readBeforeRecovery);
    expect(restored.windows[0].capsule?.x).toBe(-1000);
    expect(f.read().windows[0].capsule.x).toBe(-1000);
    expect(f.store.load().notesCompat?.windows[0].capsule?.x).toBe(-1000);
    expect(fs.existsSync(f.journalFile)).toBe(false);
    restarted.dispose();
  });
});
