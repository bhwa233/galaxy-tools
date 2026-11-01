import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import type { LayerCard } from "../shared/layer-contract.js";
import { DesktopOverlayLayout, overlayPanelKey } from "./desktop-overlay-layout.js";

const root = path.resolve("../../local-build/desktop-overlay-validation/unit");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== root) throw new Error("Invalid isolated test directory");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = path.join(root, randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  directories.push(directory);
  return { directory, file: path.join(directory, "overlay.json") };
}

test("operation placement clamps to a negative-coordinate display without changing desktop geometry", () => {
  const { file } = fixture();
  const card: LayerCard = {
    id: "traffic-fixture",
    displayId: "right",
    renderKind: "declarative",
    bounds: { x: 40, y: 80, width: 140, height: 52 },
    group: "normal",
    inputMode: "passive",
    visible: true,
    order: 0,
  };
  const original = structuredClone(card);
  const layout = new DesktopOverlayLayout(file);
  layout.position(card.id, "left", { x: 100000, y: -100000, width: 900, height: 500 });
  layout.position(card.id, "right", { x: 100, y: 200, width: 320, height: 112 });
  const restored = new DesktopOverlayLayout(file);
  expect(restored.place(card, "left", { x: -1600, y: -200, width: 1280, height: 720 }, 0)).toEqual({
    x: -1232,
    y: -90,
    width: 900,
    height: 500,
  });
  expect(restored.place(card, "right", { x: 0, y: 0, width: 1920, height: 1080 }, 0)).toEqual({
    x: 100,
    y: 200,
    width: 320,
    height: 112,
  });
  expect(card).toEqual(original);
  const note: LayerCard = {
    ...card,
    id: "notes-view:queue:left/note-1",
    renderKind: "notes",
    renderRef: "note-1",
  };
  layout.position(overlayPanelKey(note), "right", { x: 200, y: 250, width: 320, height: 160 });
  const movedNote = { ...note, id: "notes-view:floating:right/note-1", displayId: "right" };
  expect(
    new DesktopOverlayLayout(file).place(
      movedNote,
      "right",
      { x: 0, y: 0, width: 1920, height: 1080 },
      0,
    ),
  ).toEqual({ x: 200, y: 250, width: 320, height: 160 });
});

test("a failed durable update retains the prior presentation and malformed input is never replaced", () => {
  const { file, directory } = fixture();
  const layout = new DesktopOverlayLayout(file);
  layout.update("fixture", { selected: false });
  const saved = fs.readFileSync(file);
  const backup = path.join(directory, "saved.json");
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  expect(() => layout.update("fixture", { selected: true })).toThrow();
  expect(layout.get("fixture")?.selected).toBe(false);
  expect(fs.readFileSync(backup)).toEqual(saved);
  fs.rmdirSync(file);
  fs.writeFileSync(file, "{truncated");
  const corrupted = new DesktopOverlayLayout(file);
  expect(corrupted.readError).toBeTruthy();
  expect(() => corrupted.update("fixture", { selected: true })).toThrow("原文件已保留");
  expect(fs.readFileSync(file, "utf8")).toBe("{truncated");
});
