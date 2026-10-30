import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { PluginWindowStateStore } from "./plugin-window-state.js";

it("restores each plugin profile independently without using the notes database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-state-"));
  try {
    const file = path.join(root, "windows.json");
    const store = new PluginWindowStateStore(file);
    const first = {
      pluginId: "fixture.first",
      profile: "main",
      bounds: { x: 12, y: 34, width: 800, height: 600 },
      topmost: false,
    };
    const second = {
      pluginId: "fixture.second",
      profile: "main",
      bounds: { x: 56, y: 78, width: 640, height: 420 },
      topmost: true,
    };
    store.remember(first);
    store.remember(second);
    store.flush();
    first.bounds.width = 999;
    const restored = new PluginWindowStateStore(file);
    expect(restored.get("fixture.first", "main")?.bounds.width).toBe(800);
    expect(restored.get("fixture.second", "main")).toEqual(second);
    expect(restored.get("fixture.first", "quick")).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves unreadable geometry instead of replacing it with a partial new snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-window-damage-"));
  try {
    const file = path.join(root, "windows.json");
    fs.writeFileSync(file, "{ damaged");
    const store = new PluginWindowStateStore(file);
    expect(store.readError).toBeDefined();
    store.remember({
      pluginId: "fixture.first",
      profile: "main",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      topmost: false,
    });
    store.flush();
    expect(fs.readFileSync(file, "utf8")).toBe("{ damaged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
