import type { PluginSettingsField } from "./settingsTypes.js";
const field = (
  key: string,
  type: PluginSettingsField["type"],
  extra: Partial<PluginSettingsField> = {},
): PluginSettingsField => ({ key, type, label: `settings.${key}`, ...extra });
export const noteSettingsFields: PluginSettingsField[] = [
  ...[
    "noteAutoSave",
    "noteSurfaceAutoSave",
    "externalFileAutoSave",
    "rememberSurfaceSize",
    "tileCtrlClose",
    "tileDoubleClickToEdit",
    "tileSaveReturnsToPin",
    "renderHtmlMarkdown",
    "splitScrollSync",
    "imageAutoCompress",
    "reminderSound",
    "openAtCursor",
  ].map((key) => field(key, "boolean")),
  field("toggleVisibilityShortcut", "text", { label: "settings.visibilityShortcut" }),
  field("defaultViewMode", "select", { options: ["edit", "split"] }),
  field("fontSize", "number", { min: 8, max: 30 }),
  field("surfaceFontSize", "number", { min: 8, max: 30 }),
  field("tabIndentSize", "number", { min: 1, max: 8 }),
  field("tileColor", "text"),
  field("tileColorMode", "select", { options: ["system", "custom"] }),
  field("imageDisplay", "select", { options: ["show", "click", "hidden"] }),
  field("backgroundImagePath", "text"),
  field("backgroundFit", "select", { options: ["cover", "contain", "repeat"] }),
  ...[
    "backgroundDim",
    "backgroundBlur",
    "backgroundScale",
    "backgroundPositionX",
    "backgroundPositionY",
  ].map((key) => field(key, "number", { min: 0, max: 100 })),
];
export const clipboardSettingsFields: PluginSettingsField[] = [
  field("paused", "boolean", { label: "pluginConfig.fields.paused" }),
  field("excludedApps", "lines", { label: "pluginConfig.fields.excludedApps" }),
  field("excludedText", "lines", { label: "pluginConfig.fields.excludedText" }),
  field("retentionDays", "number", {
    min: 1,
    max: 36500,
    nullable: true,
    label: "pluginConfig.fields.retentionDays",
  }),
  field("visibleCount", "number", {
    min: 1,
    max: 1000000,
    nullable: true,
    label: "pluginConfig.fields.visibleCount",
  }),
  field("quickKeys", "select", {
    options: ["digits", "function"],
    label: "pluginConfig.fields.quickKeys",
  }),
  field("quickAction", "select", {
    options: ["copy", "paste"],
    label: "pluginConfig.fields.quickAction",
  }),
  field("compactPosition", "select", {
    options: ["cursor", "edge"],
    label: "pluginConfig.fields.compactPosition",
  }),
];
export const searchSettingsFields: PluginSettingsField[] = [
  field("excludedRoots", "lines", { label: "pluginConfig.fields.excludedRoots" }),
  field("extensions", "lines", { label: "pluginConfig.fields.extensions" }),
  field("maxFileMiB", "number", { min: 1, max: 64, label: "pluginConfig.fields.maxFileMiB" }),
  field("includeHidden", "boolean", { label: "pluginConfig.fields.includeHidden" }),
];
export const translationSettingsFields: PluginSettingsField[] = [
  field("endpoint", "text", { label: "translation.endpoint" }),
  field("model", "text", { label: "translation.model" }),
  field("key", "secret", { label: "translation.key" }),
];
