import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configPatchSchema, trayMenuSchema } from "../shared/config-schema.js";
import { noteSettingsFields } from "../src/features/plugins/settingsFields.js";
import type { AppConfig } from "../src/features/settings/types.js";
import { resolveAppLocale } from "../src/locales/locale-whitelist.js";
import { AppError, atomicWrite, readJson } from "./persistence.js";

export { configPatchSchema, trayMenuSchema } from "../shared/config-schema.js";
export const persistedConfigSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    // Accept old saved settings without reinstalling the retired mouse observer.
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          ![
            "superPanelEnabled",
            "superPanelButton",
            "superPanelTrigger",
            "superPanelHoldMs",
            "superPanelExcludedApps",
            "superPanelCopyFallback",
          ].includes(key),
      ),
    );
  },
  z.strictObject({
    ...configPatchSchema.shape,
    dataDir: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value)),
  }),
);

export function defaultConfig(dataDir: string): AppConfig {
  return {
    locale: "zh-CN",
    dataDir,
    globalShortcut: "Alt+Space",
    commandShortcuts: {},
    trayMenu: { hidden: [], order: [] },
    closeToTray: true,
    autostart: false,
    defaultViewMode: "edit",
    noteAutoSave: true,
    noteSurfaceAutoSave: true,
    tileColor: "#f6f3ec",
    tileColorMode: "system",
    theme: "system",
    accentColor: "green",
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
    const saved: Partial<AppConfig> = fs.existsSync(this.file)
      ? persistedConfigSchema.parse(readJson(this.file))
      : {};
    const dataDir = path.resolve(process.env.SPARK233_DATA_DIR || saved.dataDir || defaultDataDir);
    this.value = { ...defaultConfig(dataDir), ...saved, dataDir };
    const noteFile = path.join(dataDir, ".spark233-preferences.json");
    if (fs.existsSync(noteFile)) {
      const preferences = configPatchSchema.parse(readJson(noteFile));
      const keys = new Set(noteSettingsFields.map((field) => field.key));
      Object.assign(
        this.value,
        Object.fromEntries(Object.entries(preferences).filter(([key]) => keys.has(key))),
      );
    }
    this.value.locale = resolveAppLocale(saved.locale);
    this.value.defaultViewMode = this.value.defaultViewMode === "split" ? "split" : "edit";
  }
  save(config: AppConfig): AppConfig {
    if (config.trayMenu !== undefined && !trayMenuSchema.safeParse(config.trayMenu).success)
      throw new AppError("invalidPayload", "托盘菜单设置格式不合法");
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
    const noteFile = path.join(value.dataDir, ".spark233-preferences.json");
    const noteKeys = new Set(noteSettingsFields.map((field) => field.key));
    const changedNotes = noteSettingsFields.some(
      (field) =>
        JSON.stringify(value[field.key as keyof AppConfig]) !==
        JSON.stringify(this.value[field.key as keyof AppConfig]),
    );
    const previousNoteBytes = fs.existsSync(noteFile) ? fs.readFileSync(noteFile) : undefined;
    const separateNotes = changedNotes || previousNoteBytes !== undefined;
    if (changedNotes)
      atomicWrite(
        noteFile,
        JSON.stringify(
          Object.fromEntries(Object.entries(value).filter(([key]) => noteKeys.has(key))),
          null,
          2,
        ),
      );
    try {
      atomicWrite(
        this.file,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(value).filter(([key]) => !separateNotes || !noteKeys.has(key)),
          ),
          null,
          2,
        ),
      );
    } catch (error) {
      if (changedNotes) {
        if (previousNoteBytes) atomicWrite(noteFile, previousNoteBytes);
        else fs.rmSync(noteFile, { force: true });
      }
      throw error;
    }
    this.value = value;
    return value;
  }
}
