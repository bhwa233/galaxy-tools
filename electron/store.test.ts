import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NoteStore, atomicWrite, confined } from "./store";
import { FileGrants, externalUrl } from "./security";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "floral-electron-"));
  roots.push(root);
  const config = path.join(root, "config"),
    data = path.join(root, "data");
  return {
    root,
    store: new NoteStore(config, data, async (file) => fs.renameSync(file, `${file}.recycled`)),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("Electron persistence boundary", () => {
  test("persists each note's editing mode without rewriting its Markdown or touching another note", () => {
    const { root, store } = fixture();
    const source = "# 原文\n\n![](images/n/a.png){width=75%}\n";
    const first = store.save({ title: "一", content: source, category: "" });
    const second = store.save({ title: "二", content: "正文", category: "" });
    expect(first.editorMode).toBe("text");
    store.setEditorMode(first.id, "markdown");
    expect(store.get(first.id).content).toBe(source);
    expect(store.get(first.id).updatedAt).toBe(first.updatedAt);
    expect(store.get(second.id).editorMode).toBe("text");
    store.save({ title: "新标题", content: source + "编辑", category: "" }, first.id);
    const restarted = new NoteStore(path.join(root, "config"), store.dataDir, async () => {});
    expect(restarted.get(first.id).editorMode).toBe("markdown");
    expect(restarted.get(first.id).content).toBe(source + "编辑");
    expect(() => restarted.setEditorMode(first.id, "preview")).toThrow("便签模式不合法");
    expect(restarted.config.defaultViewMode).toBe("edit");
  });
  test("keeps note preferences in the note data domain across restart and migration", () => {
    const { root, store } = fixture();
    store.saveConfig({ ...store.config, fontSize: 21, noteAutoSave: false });
    const hostFile = path.join(root, "config", "config.json");
    expect(JSON.parse(fs.readFileSync(hostFile, "utf8"))).not.toHaveProperty("fontSize");
    const restarted = new NoteStore(path.join(root, "config"), store.dataDir, async () => {});
    expect(restarted.config.fontSize).toBe(21);
    expect(restarted.config.noteAutoSave).toBe(false);
    const destination = path.join(root, "new-location");
    fs.mkdirSync(destination);
    restarted.migrate(destination);
    const moved = new NoteStore(path.join(root, "config"), restarted.dataDir, async () => {});
    expect(moved.config.fontSize).toBe(21);
    expect(moved.config.noteAutoSave).toBe(false);
    expect(fs.existsSync(path.join(moved.dataDir, ".spark233-preferences.json"))).toBe(true);
  });
  test("reads the existing floral disk format, retains note identity across rename, move and restart", () => {
    const { root, store } = fixture();
    const id = "2ac849c1-bad4-47c5-b55f-1f46b12cfe83",
      oldFile = `${id}_原便签.md`;
    atomicWrite(path.join(store.dataDir, "notes", oldFile), "# 中文原文\n**保持格式**\n");
    atomicWrite(
      path.join(store.dataDir, "metadata.json"),
      JSON.stringify({
        notes: [
          {
            id,
            title: "原便签",
            fileName: oldFile,
            category: "",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            wordCount: 12,
            preview: "原文",
          },
        ],
      }),
    );
    expect(store.get(id).content).toBe("# 中文原文\n**保持格式**\n");
    store.createCategory("工作");
    store.save({ title: "新标题", content: "- [x] 已修改\n", category: "工作" }, id);
    const reopened = new NoteStore(path.join(root, "config"), store.dataDir, async () => {});
    expect(reopened.get(id)).toMatchObject({
      id,
      category: "工作",
      content: "- [x] 已修改\n",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(fs.existsSync(path.join(store.dataDir, "notes", oldFile))).toBe(false);
    reopened.deleteCategory("工作");
    expect(reopened.get(id).category).toBe("");
    expect(reopened.list().filter((note) => note.id === id)).toHaveLength(1);
  });
  test("backs up corrupt metadata and rebuilds from real Markdown without overwriting content", () => {
    const { store } = fixture();
    atomicWrite(path.join(store.dataDir, "notes", "legacy_标题.md"), "# 保留正文\n中文");
    atomicWrite(path.join(store.dataDir, "metadata.json"), "{ corrupt");
    expect(store.list()[0]).toMatchObject({ id: "legacy", title: "保留正文" });
    expect(store.get("legacy").content).toBe("# 保留正文\n中文");
    expect(fs.readdirSync(store.dataDir).some((file) => file.includes(".corrupt-"))).toBe(true);
  });
  test("metadata write failure restores an existing body and reports a failed body rollback", () => {
    const { store } = fixture();
    const old = store.save({ title: "原标题", content: "# 原文\n保留", category: "" });
    const target = store.notePath(old),
      metadata = path.join(store.dataDir, "metadata.json");
    const oldBody = fs.readFileSync(target),
      oldIndex = fs.readFileSync(metadata);
    const originalRename = fs.renameSync,
      commitFailure = new Error("OWN_METADATA_COMMIT_FAILURE");
    let failCommit = true;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === metadata && failCommit) {
        failCommit = false;
        throw commitFailure;
      }
      originalRename(source, destination);
    });
    // The body used to remain overwritten even though the metadata commit reported failure.
    expect(() => store.save({ ...old, content: "# 新正文" }, old.id)).toThrow(commitFailure);
    rename.mockRestore();
    expect(fs.readFileSync(target)).toEqual(oldBody);
    expect(fs.readFileSync(metadata)).toEqual(oldIndex);
    expect(store.get(old.id)).toEqual(old);
    expect(store.save({ ...old, content: "# 重试成功" }, old.id).content).toBe("# 重试成功");

    const retryIndex = fs.readFileSync(metadata),
      rollbackFailure = new Error("OWN_BODY_ROLLBACK_FAILURE");
    let commitRejected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === metadata) {
        commitRejected = true;
        throw commitFailure;
      }
      if (commitRejected && destination === target) throw rollbackFailure;
      originalRename(source, destination);
    });
    let failure: unknown;
    try {
      store.save({ ...old, content: "# 双故障" }, old.id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([commitFailure, rollbackFailure]);
    expect(fs.readFileSync(metadata)).toEqual(retryIndex);
  });
  test("failed rename and move leave no duplicate body and remain rebuildable and retryable", () => {
    const { store } = fixture();
    const old = store.save({
      title: "旧标题",
      content: "# 原正文\n![](images/a.png)",
      category: "",
    });
    store.createCategory("工作");
    const metadata = path.join(store.dataDir, "metadata.json"),
      oldIndex = fs.readFileSync(metadata);
    const oldBody = fs.readFileSync(store.notePath(old));
    const originalRename = fs.renameSync;
    let failCommit = true;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === metadata && failCommit) {
        failCommit = false;
        throw new Error("OWN_METADATA_COMMIT_FAILURE");
      }
      originalRename(source, destination);
    });
    // Previously this left another Markdown with the same ID, breaking metadata rebuild.
    const request = { title: "新标题", content: "# 新正文", category: "工作" };
    expect(() => store.save(request, old.id)).toThrow("OWN_METADATA_COMMIT_FAILURE");
    rename.mockRestore();
    expect(fs.readFileSync(metadata)).toEqual(oldIndex);
    expect(fs.readFileSync(store.notePath(old))).toEqual(oldBody);
    expect(fs.readdirSync(path.join(store.dataDir, "notes", "工作"))).toEqual([]);
    expect(store.get(old.id)).toEqual(old);
    expect(store.rebuild().map((note) => note.id)).toEqual([old.id]);
    expect(store.get(old.id).content).toBe(old.content);
    const saved = store.save(request, old.id);
    expect(saved).toMatchObject({ id: old.id, ...request });
    expect(fs.existsSync(store.notePath(old))).toBe(false);
    expect(store.rebuild().map((note) => note.id)).toEqual([old.id]);
    expect(store.get(old.id).content).toBe(request.content);
  });
  test("rejects traversal, junction escape and a file grant redirected after selection", () => {
    const { root, store } = fixture();
    expect(() => store.save({ title: "安全", content: "", category: "../outside" })).toThrow();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(store.dataDir, "notes", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => confined(store.dataDir, "notes", "escape", "x.md")).toThrow();
    const grants = new FileGrants();
    const selected = path.join(root, "selected");
    const initial = path.join(root, "initial");
    fs.mkdirSync(initial);
    atomicWrite(path.join(initial, "same.md"), "selected");
    atomicWrite(path.join(outside, "same.md"), "secret");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(initial, selected, linkType);
    grants.grant(path.join(selected, "same.md"));
    fs.unlinkSync(selected);
    fs.symlinkSync(outside, selected, linkType);
    expect(() => grants.assert(path.join(selected, "same.md"))).toThrow();
    expect(() => externalUrl("file:///C:/Windows/win.ini")).toThrow();
  });
  test("data-directory migration keeps image references and a recovery copy, refuses nested targets", () => {
    const { root, store } = fixture();
    const note = store.save({ title: "图片", content: "", category: "" });
    const image = store.saveImage(note.id, Buffer.from([1, 2, 3]), "png");
    store.save({ title: note.title, content: `![](${image})`, category: "" }, note.id);
    expect(() => store.migrate(path.join(store.dataDir, "nested"))).toThrow();
    const source = store.dataDir;
    store.migrate(path.join(root, "destination"));
    expect(fs.readFileSync(path.join(store.dataDir, image))).toEqual(Buffer.from([1, 2, 3]));
    expect(store.get(note.id).content).toBe(`![](${image})`);
    expect(fs.existsSync(path.join(source, image))).toBe(true);
  });
});
