import { invoke } from "../../platform/desktop";
import { open } from "../../platform/desktop";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  checkGlobalShortcut,
  chooseDataDirectory,
  getConfig,
  normalizeViewMode,
  saveConfig,
} from "./api";
import type { AppConfig } from "./types";

vi.mock("../../platform/desktop", () => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedOpen = vi.mocked(open);

describe("settings api", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedOpen.mockReset();
  });

  test("gets config through the desktop adapter", async () => {
    const config: AppConfig = {
      locale: "zh-CN",
      dataDir: "D:\\notes",
      globalShortcut: "Ctrl+Space",
      closeToTray: true,
      autostart: false,
      defaultViewMode: "split",
      noteAutoSave: true,
      noteSurfaceAutoSave: true,
      tileColor: "#f6f3ec",
      tileColorMode: "system",
      theme: "light",
      fontSize: 14,
      surfaceFontSize: 14,
      tabIndentSize: 2,
      externalFileAutoSave: true,
      rememberSurfaceSize: true,
      tileCtrlClose: true,
      tileDoubleClickToEdit: false,
      tileSaveReturnsToPin: false,
      toggleVisibilityShortcut: "",
      renderHtmlMarkdown: false,
      splitScrollSync: true,
      imageAutoCompress: true,
      imageDisplay: "show",
      reminderSound: true,
      mcpEnabled: false,
      mcpPermission: "read",
      openAtCursor: true,
    };
    mockedInvoke.mockResolvedValue(config);

    await expect(getConfig()).resolves.toBe(config);

    expect(invoke).toHaveBeenCalledWith("config_get");
  });

  test("saves config through the desktop adapter", async () => {
    const config: AppConfig = {
      locale: "zh-CN",
      dataDir: "D:\\notes",
      globalShortcut: "Alt+Space",
      closeToTray: false,
      autostart: true,
      defaultViewMode: "preview",
      noteAutoSave: false,
      noteSurfaceAutoSave: false,
      tileColor: "#efe8dc",
      tileColorMode: "custom",
      theme: "dark",
      fontSize: 16,
      surfaceFontSize: 16,
      tabIndentSize: 4,
      externalFileAutoSave: true,
      rememberSurfaceSize: true,
      tileCtrlClose: true,
      tileDoubleClickToEdit: true,
      tileSaveReturnsToPin: true,
      toggleVisibilityShortcut: "",
      renderHtmlMarkdown: false,
      splitScrollSync: true,
      imageAutoCompress: false,
      imageDisplay: "click",
      reminderSound: false,
      mcpEnabled: true,
      mcpPermission: "full",
      openAtCursor: true,
    };
    mockedInvoke.mockResolvedValue(config);

    await expect(saveConfig(config)).resolves.toBe(config);

    expect(invoke).toHaveBeenCalledWith("config_save", { config });
  });

  test("checks global shortcut availability through the desktop adapter", async () => {
    const result = {
      available: false,
      conflictType: "system",
      message: "与 macOS 系统快捷键冲突",
    };
    mockedInvoke.mockResolvedValue(result);

    await expect(checkGlobalShortcut("Command+Space")).resolves.toBe(result);

    expect(invoke).toHaveBeenCalledWith("global_shortcut_check", {
      shortcut: "Command+Space",
    });
  });

  test("normalizes removed preview and unknown view modes to visual editing", () => {
    expect(normalizeViewMode("edit")).toBe("edit");
    expect(normalizeViewMode("split")).toBe("split");
    expect(normalizeViewMode("preview")).toBe("edit");
    expect(normalizeViewMode("unknown")).toBe("edit");
  });

  test("chooses a data directory through the folder picker", async () => {
    mockedOpen.mockResolvedValue("D:\\notes");

    await expect(chooseDataDirectory()).resolves.toBe("D:\\notes");

    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    });
  });

  test("returns null when choosing a data directory is cancelled", async () => {
    mockedOpen.mockResolvedValue(null);

    await expect(chooseDataDirectory()).resolves.toBeNull();
  });
});
