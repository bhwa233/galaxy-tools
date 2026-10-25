import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../src/features/settings/types.js";
import { resolveAppLocale } from "../src/locales/locale-whitelist.js";
import { AppError, atomicWrite, readJson } from "./persistence.js";

export function defaultConfig(dataDir: string): AppConfig {
  return {
    locale: "zh-CN",
    dataDir,
    globalShortcut: "Alt+Space",
    commandShortcuts: {},
    closeToTray: true,
    autostart: false,
    defaultViewMode: "edit",
    noteAutoSave: true,
    noteSurfaceAutoSave: true,
    tileColor: "#f6f3ec",
    tileColorMode: "system",
    theme: "system",
    fontSize: 14,
    surfaceFontSize: 14,
    tabIndentSize: 2,
    externalFileAutoSave: true,
    rememberSurfaceSize: true,
    tileCtrlClose: true,
    tileDoubleClickToEdit: false,
    tileSaveReturnsToPin: false,
    renderHtmlMarkdown: false,
    splitScrollSync: true,
    imageAutoCompress: true,
    imageDisplay: "show",
    reminderSound: true,
    mcpEnabled: false,
    mcpPermission: "read",
    toggleVisibilityShortcut: "",
    openAtCursor: true,
    backgroundImagePath: "",
    backgroundFit: "cover",
    backgroundDim: 0.25,
    backgroundBlur: 0,
    backgroundScale: 1,
    backgroundPositionX: 50,
    backgroundPositionY: 50,
  };
}
/** One owner for host preferences; NoteStore delegates all writes here. */
export class HostConfigStore {
  value: AppConfig;
  readonly file: string;
  constructor(
    readonly configDir: string,
    defaultDataDir: string,
  ) {
    this.file = path.join(configDir, "config.json");
    const saved = fs.existsSync(this.file) ? readJson<Partial<AppConfig>>(this.file) : {};
    const dataDir = path.resolve(process.env.SPARK233_DATA_DIR || saved.dataDir || defaultDataDir);
    this.value = { ...defaultConfig(dataDir), ...saved, dataDir };
    this.value.locale = resolveAppLocale(saved.locale);
    this.value.defaultViewMode = this.value.defaultViewMode === "split" ? "split" : "edit";
  }
  save(config: AppConfig): AppConfig {
    if (
      config?.commandShortcuts !== undefined &&
      (typeof config.commandShortcuts !== "object" ||
        config.commandShortcuts === null ||
        Array.isArray(config.commandShortcuts) ||
        Object.keys(config.commandShortcuts).length > 128 ||
        Object.entries(config.commandShortcuts).some(
          ([id, value]) =>
            !/^([a-z][a-z0-9.-]*):([a-z][a-z0-9.-]*)$/.test(id) ||
            typeof value !== "string" ||
            value.length > 100,
        ))
    )
      throw new AppError("invalidPayload", "插件快捷键设置格式不合法");
    if (
      !config ||
      typeof config !== "object" ||
      !["system", "light", "dark"].includes(config.theme) ||
      !["system", "custom"].includes(config.tileColorMode) ||
      !["show", "click", "hidden"].includes(config.imageDisplay) ||
      !["read", "append", "full"].includes(config.mcpPermission) ||
      typeof config.globalShortcut !== "string" ||
      typeof config.toggleVisibilityShortcut !== "string" ||
      typeof config.autostart !== "boolean" ||
      typeof config.closeToTray !== "boolean"
    )
      throw new AppError("invalidPayload", "设置格式不合法");
    const value = {
      ...this.value,
      ...config,
      locale: resolveAppLocale(config.locale),
      dataDir: path.resolve(config.dataDir),
      defaultViewMode: config.defaultViewMode === "split" ? "split" : "edit",
      tabIndentSize: Math.max(1, Math.min(8, Number(config.tabIndentSize) || 2)),
    };
    atomicWrite(this.file, JSON.stringify(value, null, 2));
    this.value = value;
    return value;
  }
}
