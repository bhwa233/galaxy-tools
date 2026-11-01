import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createCommandRegistry } from "./registry.js";
import { createSettingsCommands } from "./settings-commands.js";
import type { CommandInvocation } from "./invocation.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostConfigStore } from "../host-config.js";

describe("host command boundary", () => {
  it("keeps desktop activation host-only and rolls persisted flags back when applying the layer fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-desktop-toggle-"));
    try {
      const hostConfig = new HostConfigStore(directory, path.join(directory, "notes"));
      hostConfig.save({
        ...hostConfig.value,
        desktopLayer: { enabled: false, webEnabled: false, notesEnabled: false },
      });
      const syncDesktopLayer = vi
        .fn()
        .mockRejectedValueOnce(new Error("layer refused"))
        .mockResolvedValue(undefined);
      const handlers = createSettingsCommands({
        hostConfig,
        isAdminView: (layout: { pluginId?: string }) => !layout.pluginId,
        syncDesktopLayer,
        notesActive: false,
      } as unknown as Parameters<typeof createSettingsCommands>[0]);
      const invocation = {
        win: { id: 1 },
        command: "config_patch",
        layout: { label: "settings" },
        args: { patch: { desktopLayer: { enabled: true } } },
      } as unknown as Extract<CommandInvocation, { command: "config_patch" }>;
      await expect(
        handlers.config_patch({
          ...invocation,
          layout: { label: "plugin", pluginId: "fixture.plugin" },
        } as CommandInvocation),
      ).rejects.toMatchObject({ code: "permissionDenied" });
      await expect(
        handlers.config_patch({
          ...invocation,
          args: { patch: { desktopLayer: { notesEnabled: true } } },
        }),
      ).rejects.toMatchObject({ code: "layer.disabled" });
      expect(syncDesktopLayer).not.toHaveBeenCalled();
      await expect(handlers.config_patch(invocation)).rejects.toThrow("layer refused");
      expect(syncDesktopLayer).toHaveBeenCalledTimes(2);
      expect(
        new HostConfigStore(directory, path.join(directory, "notes")).value.desktopLayer,
      ).toEqual({ enabled: false, webEnabled: false, notesEnabled: false });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps marketplace navigation restricted to host windows while allowing a plugin's own settings", async () => {
    const openHostSettings = vi.fn().mockResolvedValue(true);
    const handlers = createSettingsCommands({
      isAdminView: (layout: { pluginId?: string }) => !layout.pluginId,
      openHostSettings,
      hideHostWindow: vi.fn(),
    } as unknown as Parameters<typeof createSettingsCommands>[0]);
    const invocation = {
      win: { id: 1 },
      command: "settings_open",
      layout: { label: "plugin", pluginId: "fixture.plugin" },
      args: { page: "marketplace", pluginId: "fixture.plugin" },
    } as unknown as CommandInvocation;
    await expect(handlers.settings_open(invocation)).rejects.toMatchObject({
      code: "permissionDenied",
    });
    expect(openHostSettings).not.toHaveBeenCalled();
    await handlers.settings_open({
      ...invocation,
      command: "settings_open",
      args: { page: "plugins", pluginId: "fixture.plugin" },
    });
    expect(openHostSettings).toHaveBeenCalledWith({ page: "plugins", pluginId: "fixture.plugin" });
    openHostSettings.mockClear();
    await handlers.settings_open({
      ...invocation,
      layout: { label: "settings", view: "launcher" },
      args: { page: "marketplace" },
    } as CommandInvocation);
    expect(openHostSettings).toHaveBeenCalledWith({ page: "marketplace" });
  });

  it("rejects invalid writes before any domain handler or mutation can run", async () => {
    const dispatch = vi.fn();
    const registry = createCommandRegistry(dispatch);
    for (const [command, args] of [
      ["config_patch", { patch: { dataDir: "C:/unowned" } }],
      [
        "notes_update",
        { id: "note", request: { title: "Draft", content: "owned", category: "", admin: true } },
      ],
      ["window_control", { action: "alwaysOnTop", value: "false" }],
      ["window_control", { action: "setBounds", value: { x: NaN, y: 0, width: 320, height: 200 } }],
      ["plugin_settings_save", { pluginId: "fixture.plugin", revision: "stale", patch: {} }],
      ["images_save", { data: new Uint8Array([1]), headers: { "x-note-id": "note" } }],
      ["notes_delete", { id: "note", label: "another-window" }],
      ["not_a_command", {}],
    ] as const) {
      expect(() => registry.resolve(command, args)).toThrow();
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps queued settings tied to the validated request and dispatches binary data intact", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const registry = createCommandRegistry(dispatch);
    const win = {} as BrowserWindow;
    const input = { patch: { fontSize: 16 } };
    const command = registry.resolve("config_patch", input);
    input.patch.fontSize = 24;
    await command.run(win);
    expect(dispatch).toHaveBeenLastCalledWith(win, "config_patch", { patch: { fontSize: 16 } });
    const data = new Uint8Array([137, 80, 78, 71]);
    await registry
      .resolve("images_save", { data, headers: { "x-note-id": "note", "x-image-ext": "png" } })
      .run(win);
    expect(dispatch).toHaveBeenLastCalledWith(win, "images_save", {
      data,
      headers: { "x-note-id": "note", "x-image-ext": "png" },
    });
  });
});
