import { noteSettingsFields } from "../src/features/plugins/settingsFields.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../src/features/settings/types.js";
import { resolveAppLocale, SUPPORTED_LOCALES } from "../src/locales/locale-whitelist.js";
import { normalizeTileColor } from "../src/features/settings/tileColor.js";
import { AppError, atomicWrite, readJson } from "./persistence.js";

const superPanelFields = {
  superPanelEnabled: z.boolean(),
  superPanelButton: z.enum(["middle", "x1", "x2"]),
  superPanelTrigger: z.enum(["click", "hold"]),
  superPanelHoldMs: z.number().int().min(200).max(1500),
  superPanelExcludedApps: z
    .array(
      z
        .string()
        .trim()
        .min(5)
        .max(120)
        .refine((value) => !/[\\/:]/.test(value) && !/\p{Cc}/u.test(value) && /\.exe$/i.test(value))
        .transform((value) => value.toLowerCase()),
    )
    .max(64)
    .transform((values) => [...new Set(values)]),
  superPanelCopyFallback: z.boolean(),
};
const superPanelSettings = z.object(superPanelFields);
// Explicit mutable fields only: unknown keys, including dataDir, must never
// reach the host preferences through an ordinary settings write.
export const configPatchSchema = z
  .strictObject({
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    superPanelEnabled: superPanelFields.superPanelEnabled.optional(),
    superPanelButton: superPanelFields.superPanelButton.optional(),
    superPanelTrigger: superPanelFields.superPanelTrigger.optional(),
    superPanelHoldMs: superPanelFields.superPanelHoldMs.optional(),
    superPanelExcludedApps: superPanelFields.superPanelExcludedApps.optional(),
    superPanelCopyFallback: superPanelFields.superPanelCopyFallback.optional(),
    globalShortcut: z.string().max(100).optional(),
    commandShortcuts: z
      .record(z.string().regex(/^([a-z][a-z0-9.-]*):([a-z][a-z0-9.-]*)$/), z.string().max(100))
      .refine((value) => Object.keys(value).length <= 128)
      .optional(),
    closeToTray: z.boolean().optional(),
    autostart: z.boolean().optional(),
    defaultViewMode: z.enum(["edit", "split"]).optional(),
    noteAutoSave: z.boolean().optional(),
    noteSurfaceAutoSave: z.boolean().optional(),
    tileColor: z.string().max(100).transform(normalizeTileColor).optional(),
    tileColorMode: z.enum(["system", "custom"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    fontSize: z.number().min(8).max(30).optional(),
    surfaceFontSize: z.number().min(8).max(30).optional(),
    tabIndentSize: z.number().int().min(1).max(8).optional(),
    externalFileAutoSave: z.boolean().optional(),
    rememberSurfaceSize: z.boolean().optional(),
    tileCtrlClose: z.boolean().optional(),
    tileDoubleClickToEdit: z.boolean().optional(),
    tileSaveReturnsToPin: z.boolean().optional(),
    renderHtmlMarkdown: z.boolean().optional(),
    splitScrollSync: z.boolean().optional(),
    imageAutoCompress: z.boolean().optional(),
    imageDisplay: z.enum(["show", "click", "hidden"]).optional(),
    reminderSound: z.boolean().optional(),
    mcpEnabled: z.boolean().optional(),
    mcpPermission: z.enum(["read", "append", "full"]).optional(),
    surfaceWidth: z.number().min(160).max(10000).optional(),
    surfaceHeight: z.number().min(60).max(10000).optional(),
    toggleVisibilityShortcut: z.string().max(100).optional(),
    openAtCursor: z.boolean().optional(),
    backgroundImagePath: z.string().max(32768).optional(),
    backgroundFit: z.enum(["cover", "contain", "repeat"]).optional(),
    backgroundDim: z.number().min(0).max(1).optional(),
    backgroundBlur: z.number().min(0).max(20).optional(),
    backgroundScale: z.number().min(0.5).max(2).optional(),
    backgroundPositionX: z.number().min(0).max(100).optional(),
    backgroundPositionY: z.number().min(0).max(100).optional(),
  })
  .refine((patch) => Object.values(patch).every((value) => value !== undefined));

export function defaultConfig(dataDir: string): AppConfig {
  return {
    locale: "zh-CN",
    superPanelEnabled: false,
    superPanelButton: "middle",
    superPanelTrigger: "hold",
    superPanelHoldMs: 500,
    superPanelExcludedApps: [],
    superPanelCopyFallback: false,
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
    const panel = superPanelSettings.safeParse(this.value);
    // Never turn malformed persisted input into an enabled global observer.
    Object.assign(
      this.value,
      panel.success ? panel.data : superPanelSettings.parse(defaultConfig(dataDir)),
    );
  }
  save(config: AppConfig): AppConfig {
    const panel = superPanelSettings.safeParse(config);
    if (!panel.success) throw new AppError("invalidPayload", "超级面板设置格式不合法");
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
      ...panel.data,
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
