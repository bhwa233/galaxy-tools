/* eslint-disable no-control-regex -- Package paths must reject control characters. */
import { z } from "zod";

export const HOST_API_VERSION = "1.3.0";
export const THEME_API_VERSION = "1.0.0";

// Reuse Zod already present in the toolchain for one shared runtime/type schema;
// package-specific compatibility and filesystem checks belong to the host.
const localId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const range = z.string().min(1).max(128);
const label = z.string().trim().min(1).max(160);

/** Host-supplied source identity is an executable basename, never a path or HWND. */
export const sourceApplicationSchema = z
  .string()
  .max(260)
  .refine((value) => !/\p{Cc}/u.test(value), "Source application cannot contain control characters")
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(5)
      .regex(/^[^\\/:<>"|?*]+\.exe$/i),
  );

/** Portable package paths, before any host filesystem interpretation. */
export function isPluginPackagePath(value: string): boolean {
  if (!value || value.length > 512 || /[\\:\x00-\x1f]/.test(value) || value.startsWith("/"))
    return false;
  return value
    .split("/")
    .every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        !/[<>"|?*]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    );
}

const packagePath = z
  .string()
  .refine(isPluginPackagePath, "Expected a portable relative package path");
export const pluginCapabilitySchema = z.enum([
  "storage",
  "windows",
  "shortcuts",
  "tray",
  "notifications",
  "network",
  "files.read",
  "files.write",
  "clipboard.read",
  "clipboard.write",
  "clipboard.watch",
  "native.process",
  "node.backend",
  "search.index",
  "commands",
]);
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;

const translatedCommand = z.strictObject({
  title: label,
  description: z.string().max(500).optional(),
});
const rasterIconSchema = z.strictObject({
  png: packagePath.refine((value) => /\.png$/i.test(value)),
  ico: packagePath.refine((value) => /\.ico$/i.test(value)).optional(),
});
export const pluginIconSchema = rasterIconSchema.extend({
  monochrome: z.boolean().optional(),
  themes: z
    .partialRecord(
      z.enum(["green", "blue", "purple", "orange", "rose"]),
      z.strictObject({ light: rasterIconSchema, dark: rasterIconSchema }),
    )
    .optional(),
});
const windowSizeSchema = z.strictObject({
  width: z.number().int().min(160).max(8192),
  height: z.number().int().min(60).max(8192),
});
export const pluginWindowSchema = z.strictObject({
  entry: packagePath.refine((value) => /\.html$/i.test(value)),
  title: label.optional(),
  translations: z
    .strictObject({
      "zh-CN": z.strictObject({ title: label }).optional(),
      "en-US": z.strictObject({ title: label }).optional(),
    })
    .optional(),
  icon: pluginIconSchema.optional(),
  size: windowSizeSchema.optional(),
  minSize: windowSizeSchema.optional(),
  resizable: z.boolean().optional(),
  maximizable: z.boolean().optional(),
  taskbar: z.boolean().optional(),
  reuse: z.enum(["singleton", "document"]).optional(),
  presentation: z.enum(["standard", "compact"]).optional(),
  legacyLabels: z.array(localId).max(8).optional(),
});
export type PluginWindow = z.infer<typeof pluginWindowSchema>;
export type PluginIcon = z.infer<typeof pluginIconSchema>;
export const launcherPresentationSchema = z.strictObject({
  role: z.enum(["entry", "action", "keyword-only", "hidden"]),
  /** Hidden commands can still be offered for a matching explicit input. */
  withInput: z.boolean().optional(),
  input: z.enum(["query", "context"]).optional(),
  preferSentence: z.boolean().optional(),
});
const commandSchema = z.strictObject({
  id: localId,
  internal: z.boolean().default(false),
  title: label,
  launcher: launcherPresentationSchema.optional(),
  window: localId.optional(),
  progress: z
    .strictObject({
      title: label,
      cancelCommand: localId,
      translations: z
        .strictObject({
          "zh-CN": z.strictObject({ title: label }).optional(),
          "en-US": z.strictObject({ title: label }).optional(),
        })
        .optional(),
    })
    .optional(),
  description: z.string().max(500).optional(),
  keywords: z.array(z.string().min(1).max(80)).max(32).default([]),
  aliases: z.array(z.string().min(1).max(80)).max(32).default([]),
  inputs: z
    .array(z.enum(["text", "image", "files", "window"]))
    .max(4)
    .default([]),
  match: z.enum(["word", "text", "image", "files", "window"]).optional(),
  sourceApplications: z
    .array(sourceApplicationSchema)
    .min(1)
    .max(32)
    .transform((values) => [...new Set(values)])
    .optional(),
  search: z.enum(["mode", "word", "default"]).optional(),
  mode: localId.optional(),
  requiresPlugins: z.array(localId).max(32).optional(),
  translations: z
    .strictObject({ "zh-CN": translatedCommand.optional(), "en-US": translatedCommand.optional() })
    .optional(),
});
const modeSchema = z.strictObject({
  id: localId,
  title: label,
  placeholder: z.string().max(160).optional(),
  directoryFilter: z.boolean().default(false),
  translations: z
    .strictObject({
      "zh-CN": z
        .strictObject({ title: label, placeholder: z.string().max(160).optional() })
        .optional(),
      "en-US": z
        .strictObject({ title: label, placeholder: z.string().max(160).optional() })
        .optional(),
    })
    .optional(),
});
const trayItemSchema = z.strictObject({
  id: localId,
  commandId: localId,
  title: label.optional(),
  group: label.optional(),
  order: z.number().int().min(-10000).max(10000).optional(),
  type: z.enum(["normal", "checkbox"]).optional(),
  translations: z
    .strictObject({
      "zh-CN": z.strictObject({ title: label }).optional(),
      "en-US": z.strictObject({ title: label }).optional(),
    })
    .optional(),
});
export type PluginTrayItem = z.infer<typeof trayItemSchema>;
export interface PluginTrayItemState {
  checked?: boolean;
  enabled?: boolean;
}

const nativeSchema = z.strictObject({
  path: packagePath,
  args: z.array(z.string().max(4096)).max(64).default([]),
});

export const pluginManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: localId.refine(isPluginPackagePath, "Plugin ID must also be a portable directory name"),
    displayName: label,
    translations: z
      .strictObject({
        "zh-CN": z.strictObject({ displayName: label }).optional(),
        "en-US": z.strictObject({ displayName: label }).optional(),
      })
      .optional(),
    api: range,
    host: range,
    platforms: z
      .array(z.enum(["win32", "darwin", "linux"]))
      .min(1)
      .max(3),
    architectures: z
      .array(z.enum(["x64", "arm64"]))
      .min(1)
      .max(2),
    activation: z.enum(["on-command", "on-startup"]).default("on-command"),
    capabilities: z.array(pluginCapabilitySchema).max(32).default([]),
    entry: packagePath.optional(),
    backend: z.strictObject({ entry: packagePath }).optional(),
    migration: z.strictObject({ entry: packagePath }).optional(),
    native: z.record(localId, nativeSchema).default({}),
    commands: z.array(commandSchema).max(128).default([]),
    tray: z.array(trayItemSchema).max(32).optional(),
    modes: z.array(modeSchema).max(32).default([]),
    dependencies: z.record(localId, range).default({}),
    optionalDependencies: z.record(localId, range).default({}),
    dataVersion: z.number().int().nonnegative().safe().default(0),
    ui: z
      .strictObject({
        theme: range,
        icon: pluginIconSchema.optional(),
        windows: z.record(localId, pluginWindowSchema).optional(),
      })
      .optional(),
  })
  .superRefine((manifest, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      manifest.platforms.includes("win32") &&
      Object.values(manifest.native).some((entry) => !/\.exe$/i.test(entry.path))
    )
      issue("Windows native entries must use .exe files");
    if (!manifest.entry && !manifest.backend && !Object.keys(manifest.native).length)
      issue("A plugin needs a web, backend or native entry");
    if (manifest.backend && !manifest.capabilities.includes("node.backend"))
      issue("Backend entry requires node.backend");
    if (manifest.migration && !manifest.capabilities.includes("node.backend"))
      issue("Migration entry requires node.backend");
    if (Object.keys(manifest.native).length && !manifest.capabilities.includes("native.process"))
      issue("Native entries require native.process");
    if (new Set(manifest.commands.map((command) => command.id)).size !== manifest.commands.length)
      issue("Duplicate command ID");
    if (new Set(manifest.modes.map((mode) => mode.id)).size !== manifest.modes.length)
      issue("Duplicate mode ID");
    if (new Set(manifest.tray?.map((item) => item.id)).size !== (manifest.tray?.length ?? 0))
      issue("Duplicate tray item ID");
    for (const item of manifest.tray ?? []) {
      if (!manifest.commands.some((command) => command.id === item.commandId && !command.internal))
        issue("Tray item must reference this plugin's public command: " + item.commandId);
    }
    for (const command of manifest.commands) {
      if (command.window && !Object.hasOwn(manifest.ui?.windows ?? {}, command.window))
        issue(`Unknown command window: ${command.window}`);
      if (
        command.progress &&
        !manifest.commands.some(
          (value) => value.id === command.progress!.cancelCommand && !value.internal,
        )
      )
        issue(`Unknown progress cancellation command: ${command.progress.cancelCommand}`);
      if (command.internal && command.launcher && command.launcher.role !== "hidden")
        issue(`Internal command cannot be a launcher entry: ${command.id}`);
      if (command.mode && !manifest.modes.some((mode) => mode.id === command.mode))
        issue(`Unknown command mode: ${command.mode}`);
      for (const dependency of command.requiresPlugins ?? [])
        if (
          !Object.hasOwn(manifest.dependencies, dependency) &&
          !Object.hasOwn(manifest.optionalDependencies, dependency)
        )
          issue(`Command dependency must be declared by the plugin: ${dependency}`);
    }
    if (manifest.commands.filter((command) => command.launcher?.role === "entry").length > 1)
      issue("A plugin can declare at most one launcher entry");
    for (const window of Object.values(manifest.ui?.windows ?? {})) {
      if (
        window.size &&
        window.minSize &&
        (window.size.width < window.minSize.width || window.size.height < window.minSize.height)
      )
        issue("Window size cannot be smaller than its minimum size");
    }
    if (
      Object.hasOwn(manifest.dependencies, manifest.id) ||
      Object.hasOwn(manifest.optionalDependencies, manifest.id)
    )
      issue("A plugin cannot depend on itself");
  });

export const pluginPackageSchema = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128),
  description: z.string().max(1000).optional(),
  license: z.string().max(200).optional(),
  spark233: pluginManifestSchema,
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginCommand = PluginManifest["commands"][number];
export type PluginPackageMetadata = z.infer<typeof pluginPackageSchema>;

/** The same declaration policy is used for discovery and execution. The host
 * must obtain sourceApplication from its own current caller context. */
export function commandMatchesSourceApplication(
  command: Pick<PluginCommand, "sourceApplications"> &
    Partial<Pick<PluginCommand, "inputs" | "match">>,
  context?: { sourceApplication?: string },
): boolean {
  if (
    !command.sourceApplications &&
    !command.inputs?.includes("window") &&
    command.match !== "window"
  )
    return true;
  const source = sourceApplicationSchema.safeParse(context?.sourceApplication);
  return (
    source.success &&
    (!command.sourceApplications || command.sourceApplications.includes(source.data))
  );
}

/** Translate presentation fields while preserving command IDs and capabilities. */
export function localizePluginManifest(manifest: PluginManifest, locale: string): PluginManifest {
  const language = locale.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
  return {
    ...manifest,
    ...manifest.translations?.[language],
    ...(manifest.ui
      ? {
          ui: {
            ...manifest.ui,
            ...(manifest.ui.windows
              ? {
                  windows: Object.fromEntries(
                    Object.entries(manifest.ui.windows).map(([id, window]) => [
                      id,
                      {
                        ...window,
                        ...window.translations?.[language],
                      },
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
    commands: manifest.commands.map((command) => ({
      ...command,
      ...command.translations?.[language],
      ...(command.progress
        ? { progress: { ...command.progress, ...command.progress.translations?.[language] } }
        : {}),
    })),
    modes: manifest.modes.map((mode) => ({ ...mode, ...mode.translations?.[language] })),
    ...(manifest.tray
      ? { tray: manifest.tray.map((item) => ({ ...item, ...item.translations?.[language] })) }
      : {}),
  };
}
