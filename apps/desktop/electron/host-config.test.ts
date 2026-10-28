import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultConfig, HostConfigStore } from "./host-config.js";

it("loads old panel settings without restoring the observer and removes them on the next save", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-selection-config-"));
  try {
    const dataDir = path.join(root, "notes");
    const saved = {
      ...defaultConfig(dataDir),
      globalShortcut: "Ctrl+Alt+Space",
      superPanelEnabled: true,
      superPanelButton: "middle",
      superPanelTrigger: "hold",
      superPanelHoldMs: 500,
      superPanelExcludedApps: [],
      superPanelCopyFallback: true,
    };
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(saved));
    const store = new HostConfigStore(root, dataDir);
    expect(store.value.globalShortcut).toBe("Ctrl+Alt+Space");
    expect(store.value.dataDir).toBe(dataDir);
    expect(store.value).not.toHaveProperty("superPanelEnabled");
    store.save(store.value);
    const persisted = JSON.parse(fs.readFileSync(store.file, "utf8"));
    expect(persisted).not.toHaveProperty("superPanelCopyFallback");
    expect(persisted.globalShortcut).toBe("Ctrl+Alt+Space");
    fs.writeFileSync(store.file, JSON.stringify({ ...saved, arbitrarySetting: true }));
    expect(() => new HostConfigStore(root, dataDir)).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
