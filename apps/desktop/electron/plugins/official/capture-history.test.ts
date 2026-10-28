import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CaptureHistory } from "./capture-history.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-capture-history-"));
  roots.push(root);
  return { root, dataDir: path.join(root, "data") };
}
function source(dataDir: string, name: string) {
  const directory = path.join(dataDir, "incoming");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, Buffer.alloc(64, 7));
  return file;
}

it("keeps only the newest entries and deletes their images with them", () => {
  const { dataDir } = fixture();
  const history = new CaptureHistory(dataDir, { maxEntries: 3 });
  for (const name of ["a", "b", "c", "d", "e"])
    history.add(source(dataDir, `${name}.png`), { width: 2, height: 2, action: "copy" });
  const entries = history.list();
  expect(entries).toHaveLength(3);
  // Newest first, and the evicted images are gone rather than orphaned.
  expect(entries.map((entry) => entry.action)).toEqual(["copy", "copy", "copy"]);
  expect(fs.readdirSync(path.join(dataDir, "history", "images"))).toHaveLength(3);
  for (const entry of entries) expect(fs.existsSync(history.file(entry.id))).toBe(true);
});

it("records the action that completed the screenshot", () => {
  const { dataDir } = fixture();
  const history = new CaptureHistory(dataDir);
  expect(
    history.add(source(dataDir, "copy.png"), { width: 4, height: 3, action: "copy" }),
  ).toBeTruthy();
  expect(history.add(source(dataDir, "save.png"), { width: 4, height: 3, action: "save" }));
  expect(history.list().map((entry) => entry.action)).toEqual(["save", "copy"]);
});

it("a damaged index never blocks a new screenshot", () => {
  const { dataDir } = fixture();
  fs.mkdirSync(path.join(dataDir, "history", "images"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "history", "index.json"), "{ not json");
  const history = new CaptureHistory(dataDir);
  expect(history.list()).toEqual([]);
  history.add(source(dataDir, "a.png"), { width: 1, height: 1, action: "ocr" });
  expect(history.list()).toHaveLength(1);
});

it("drops rows whose image disappeared instead of serving a broken entry", () => {
  const { dataDir } = fixture();
  const history = new CaptureHistory(dataDir);
  const entry = history.add(source(dataDir, "a.png"), { width: 1, height: 1, action: "copy" })!;
  fs.rmSync(history.file(entry.id));
  expect(history.list()).toEqual([]);
  // The stale row is still addressable: removing it is not an error.
  expect(history.remove(entry.id)).toBe(true);
  expect(history.remove(entry.id)).toBe(false);
});

it("clears both the index and the stored images", () => {
  const { dataDir } = fixture();
  const history = new CaptureHistory(dataDir);
  history.add(source(dataDir, "a.png"), { width: 1, height: 1, action: "copy" });
  history.add(source(dataDir, "b.png"), { width: 1, height: 1, action: "save" });
  history.clear();
  expect(history.list()).toEqual([]);
  expect(fs.readdirSync(path.join(dataDir, "history", "images"))).toEqual([]);
});

it("rejects an id that would escape the history directory", () => {
  const { dataDir } = fixture();
  const history = new CaptureHistory(dataDir);
  expect(() => history.file("../../secret")).toThrow();
});
