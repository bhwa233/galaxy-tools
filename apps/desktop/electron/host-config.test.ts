import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultConfig, HostConfigStore } from "./host-config.js";

it("fills missing command defaults while preserving custom and explicitly disabled bindings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-shortcut-config-"));
  try {
    const dataDir = path.join(root, "notes");
    const defaults = defaultConfig(dataDir);
    fs.writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({
        ...defaults,
        commandShortcuts: {
          "spark233.clipboard:quick": "",
          "fixture.plugin:open": "Ctrl+K",
        },
      }),
    );
    const store = new HostConfigStore(root, dataDir);
    expect(store.value.commandShortcuts).toEqual({
      ...defaults.commandShortcuts,
      "spark233.clipboard:quick": "",
      "fixture.plugin:open": "Ctrl+K",
    });
    store.save({
      ...store.value,
      commandShortcuts: {
        ...store.value.commandShortcuts,
        "spark233.screenshot:capture": "Ctrl+J",
      },
    });
    expect(new HostConfigStore(root, dataDir).value.commandShortcuts).toEqual({
      "spark233.screenshot:capture": "Ctrl+J",
      "spark233.clipboard:quick": "",
      "fixture.plugin:open": "Ctrl+K",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    delete saved.desktopLayer;
    delete saved.desktopOverlayShortcut;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(saved));
    const store = new HostConfigStore(root, dataDir);
    expect(store.value.globalShortcut).toBe("Ctrl+Alt+Space");
    expect(store.value.desktopOverlayShortcut).toBe("Ctrl+Alt+D");
    expect(store.value.dataDir).toBe(dataDir);
    expect(store.value).not.toHaveProperty("superPanelEnabled");
    expect(store.value.desktopLayer).toEqual({
      enabled: true,
      webEnabled: true,
      notesEnabled: true,
    });
    store.save(store.value);
    const persisted = JSON.parse(fs.readFileSync(store.file, "utf8"));
    expect(persisted).not.toHaveProperty("superPanelCopyFallback");
    expect(persisted.globalShortcut).toBe("Ctrl+Alt+Space");
    store.save({ ...store.value, desktopOverlayShortcut: "" });
    expect(new HostConfigStore(root, dataDir).value.desktopOverlayShortcut).toBe("");
    fs.writeFileSync(store.file, JSON.stringify({ ...saved, arbitrarySetting: true }));
    expect(() => new HostConfigStore(root, dataDir)).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("normalizes persisted partial desktop flags and rejects invalid flags without changing durable preferences", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-desktop-config-"));
  try {
    const dataDir = path.join(root, "notes"),
      file = path.join(root, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...defaultConfig(dataDir), desktopLayer: { enabled: false } }),
    );
    const store = new HostConfigStore(root, dataDir);
    expect(store.value.desktopLayer).toEqual({
      enabled: false,
      webEnabled: true,
      notesEnabled: true,
    });
    store.save({
      ...store.value,
      desktopLayer: { enabled: true, webEnabled: true, notesEnabled: false },
    });
    const durable = fs.readFileSync(file, "utf8");
    expect(new HostConfigStore(root, dataDir).value.desktopLayer).toEqual({
      enabled: true,
      webEnabled: true,
      notesEnabled: false,
    });
    expect(() =>
      store.save({
        ...store.value,
        desktopLayer: { ...store.value.desktopLayer!, enabled: "yes" as unknown as boolean },
      }),
    ).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(durable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
