import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
