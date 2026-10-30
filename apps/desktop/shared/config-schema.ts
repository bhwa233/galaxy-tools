import { z } from "zod";
import { SUPPORTED_LOCALES } from "../src/locales/locale-whitelist.js";
import { normalizeTileColor } from "../src/features/settings/tileColor.js";
export const trayMenuSchema = z.strictObject({
  hidden: z.array(z.string().regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/)).max(512),
  order: z.array(z.string().regex(/^[a-z][a-z0-9.-]*(?::[a-z][a-z0-9.-]*)?$/)).max(512),
});
// Explicit mutable fields only: unknown keys, including dataDir, must never
// reach the host preferences through an ordinary settings write.
export const configPatchSchema = z
  .strictObject({
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    globalShortcut: z.string().max(100).optional(),
    commandShortcuts: z
      .record(z.string().regex(/^([a-z][a-z0-9.-]*):([a-z][a-z0-9.-]*)$/), z.string().max(100))
      .refine((value) => Object.keys(value).length <= 128)
      .optional(),
    trayMenu: trayMenuSchema.optional(),
    closeToTray: z.boolean().optional(),
    autostart: z.boolean().optional(),
    defaultViewMode: z.enum(["edit", "split"]).optional(),
    noteAutoSave: z.boolean().optional(),
    noteSurfaceAutoSave: z.boolean().optional(),
    tileColor: z.string().max(100).transform(normalizeTileColor).optional(),
    tileColorMode: z.enum(["system", "custom"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    accentColor: z.enum(["green", "blue", "purple", "orange", "rose"]).optional(),
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

/** Validate persisted/backup fields too; ordinary patch validation excludes dataDir. */
