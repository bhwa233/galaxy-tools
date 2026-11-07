/* eslint-disable no-control-regex -- Package paths must reject control characters. */
import { z } from "zod";
import { isWidgetRankRows } from "./widget.js";

export const HOST_API_VERSION = "1.7.0";
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
  titleBar: z.enum(["native", "custom"]).optional(),
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
  /** Host API 1.7: results this command's search provider contributes per query. */
  quota: z.number().int().min(1).max(100).optional(),
  /** Host API 1.7: query this provider without the typing debounce (cheap, local). */
  immediate: z.boolean().optional(),
  /** Host API 1.7: keep this command listed beyond the launcher's per-query cutoff. */
  alwaysListed: z.boolean().optional(),
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
  compatibilityQuery: z.literal("utools").optional(),
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

const widgetSizeSchema = z.strictObject({
  width: z.number().int().min(32).max(1200),
  height: z.number().int().min(32).max(900),
});
const widgetValueSchema = z.union([
  z.string().max(2048),
  z.number().finite().min(-1e15).max(1e15),
  z.boolean(),
  z.null(),
  z.array(z.number().finite().min(-1e15).max(1e15)).max(120),
  z.custom<import("./widget.js").WidgetRankRow[]>(isWidgetRankRows),
]);
const widgetFormatSchema = z.enum(["text", "number", "progress", "icon", "series", "rows"]);
export const widgetDataSourceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("static"),
    format: widgetFormatSchema,
    value: widgetValueSchema,
  }),
  z.strictObject({
    source: z.literal("host"),
    format: widgetFormatSchema,
    provider: z.literal("host.clock"),
  }),
  z.strictObject({
    source: z.literal("backend"),
    format: widgetFormatSchema,
    event: localId,
    subscriptionAction: localId,
  }),
  z.strictObject({
    source: z.literal("native"),
    format: widgetFormatSchema,
    event: localId,
    entryId: localId.optional(),
    subscriptionAction: localId,
  }),
]);
export const widgetActionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("query"),
    commandId: localId,
    entryId: localId.optional(),
  }),
  z.strictObject({
    mode: z.literal("action"),
    commandId: localId,
    entryId: localId.optional(),
  }),
  z.strictObject({
    mode: z.literal("open-main"),
    commandId: localId,
  }),
]);
const widgetCommon = {
  title: label,
  translations: z
    .strictObject({
      "zh-CN": z.strictObject({ title: label }).optional(),
      "en-US": z.strictObject({ title: label }).optional(),
    })
    .optional(),
  size: widgetSizeSchema,
  minSize: widgetSizeSchema.optional(),
  maxSize: widgetSizeSchema.optional(),
  resizable: z.boolean().default(false),
  group: z.enum(["normal", "top"]).default("normal"),
  clickThrough: z.boolean().default(false),
  interactive: z.boolean().default(true),
  commands: z.array(localId).max(8).default([]),
  refreshMs: z.number().int().min(250).max(60000).default(1000),
  data: z.record(localId, widgetDataSourceSchema).default({}),
  actions: z.record(localId, widgetActionSchema).default({}),
};
export const pluginWidgetSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...widgetCommon,
      kind: z.literal("web"),
      entry: packagePath
        .refine((v) => v.startsWith("widgets/"), "Widget entry must live under widgets/")
        .refine((v) => /\.html$/i.test(v), "Widget web entry must be an .html file"),
    }),
    z.strictObject({
      ...widgetCommon,
      kind: z.literal("declarative"),
      // Accept earlier installed manifests so they can be replaced safely.
      // The host ignores the legacy width hint and uses the declared width.
      contentWidth: z.boolean().optional(),
      // Trusted host content may choose its height within minSize/maxSize.
      contentHeight: z.boolean().optional(),
      template: packagePath
        .refine((v) => v.startsWith("widgets/"), "Widget template must live under widgets/")
        .refine((v) => /\.json$/i.test(v), "Widget template must be a .json file"),
      desktopInteractions: z
        .strictObject({
          primaryAction: localId,
          hover: z
            .strictObject({
              template: packagePath.refine(
                (v) => v.startsWith("widgets/") && /\.json$/i.test(v),
                "Hover template must be a widget JSON file",
              ),
              size: widgetSizeSchema,
            })
            .optional(),
          menu: z.strictObject({ openLabel: label, hideLabel: label }).optional(),
          edgeAutoHide: z.boolean().default(false),
          fullscreenAutoHide: z.boolean().default(true),
        })
        .optional(),
    }),
  ])
  .superRefine((w, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const min = w.minSize ?? { width: 80, height: 32 };
    const max = w.maxSize ?? { width: 1200, height: 900 };
    if (
      (w.kind !== "declarative" || !w.contentWidth) &&
      [w.size, w.minSize, w.maxSize].some((size) => size && size.width < 80)
    )
      issue(["minSize"], "Only legacy content-width widgets can be narrower than 80");
    if (min.width > max.width || min.height > max.height)
      issue(["minSize"], "Widget minimum size cannot exceed its maximum size");
    if (
      w.size.width < min.width ||
      w.size.height < min.height ||
      w.size.width > max.width ||
      w.size.height > max.height
    )
      issue(["size"], "Widget size must be within minSize and maxSize");
    if (w.clickThrough === w.interactive)
      issue(["interactive"], "Widget must be either passive or interactive");
    if (new Set(w.commands).size !== w.commands.length)
      issue(["commands"], "Duplicate widget command ID");
    if (Object.keys(w.data).length > 16) issue(["data"], "Widget can declare at most 16 data keys");
    if (Object.keys(w.actions).length > 8)
      issue(["actions"], "Widget can declare at most 8 actions");
    if (!w.interactive && Object.values(w.actions).some((a) => a.mode !== "query"))
      issue(["actions"], "Passive widget cannot declare user actions");
    if (
      w.kind === "declarative" &&
      w.desktopInteractions &&
      (!w.interactive || w.actions[w.desktopInteractions.primaryAction]?.mode !== "open-main")
    )
      issue(
        ["desktopInteractions", "primaryAction"],
        "Desktop primary action must reference an interactive open-main action",
      );
    for (const key of [...Object.keys(w.data), ...Object.keys(w.actions)])
      if (["__proto__", "prototype", "constructor"].includes(key))
        issue(["data"], "Reserved widget key");
    for (const [key, d] of Object.entries(w.data)) {
      if (d.source !== "static") continue;
      const valid =
        d.value === null ||
        (d.format === "text" && typeof d.value === "string") ||
        (d.format === "number" && typeof d.value === "number") ||
        (d.format === "progress" && typeof d.value === "number" && d.value >= 0 && d.value <= 1) ||
        (d.format === "icon" &&
          typeof d.value === "string" &&
          /^[a-z][a-z0-9.-]{0,79}$/.test(d.value)) ||
        (d.format === "series" &&
          Array.isArray(d.value) &&
          d.value.every((v) => typeof v === "number")) ||
        (d.format === "rows" && isWidgetRankRows(d.value));
      if (!valid) issue(["data", key], "Widget static value does not match its format");
    }
  });
export type PluginWidget = z.infer<typeof pluginWidgetSchema>;
export type WidgetDataSource = z.infer<typeof widgetDataSourceSchema>;
export type WidgetAction = z.infer<typeof widgetActionSchema>;
export type WidgetDataFormat = WidgetDataSource["format"];

type WidgetManifestChecks = {
  entry?: string;
  backend?: { entry: string };
  native: Record<string, { path: string; args: string[] }>;
  commands: Array<{
    id: string;
    internal: boolean;
    window?: string;
    inputs: string[];
    match?: string;
    sourceApplications?: string[];
  }>;
  ui?: { widgets?: Record<string, PluginWidget>; windows?: Record<string, unknown> };
};
function refineWidgets(m: WidgetManifestChecks, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const widgets = m.ui?.widgets ?? {};
  if (!m.entry && !m.backend && !Object.keys(m.native).length && !Object.keys(widgets).length)
    issue([], "A plugin needs a web, backend, native or widget entry");
  if (Object.keys(widgets).length > 8)
    issue(["ui", "widgets"], "A plugin can declare at most 8 widget definitions");
  const nativeEntry = (id?: string) =>
    id
      ? Object.hasOwn(m.native, id)
      : Object.keys(m.native).length === 1 || Object.hasOwn(m.native, "main");
  for (const [id, w] of Object.entries(widgets)) {
    const p = ["ui", "widgets", id];
    if (Object.hasOwn(m.ui?.windows ?? {}, id))
      issue(p, "Widget ID must not duplicate a window ID");
    for (const commandId of w.commands) {
      if (!m.commands.some((c) => c.id === commandId && !c.internal))
        issue([...p, "commands"], "Widget command must be a public command of this plugin");
    }
    for (const [key, d] of Object.entries(w.data)) {
      if (d.source === "backend" && !m.backend)
        issue([...p, "data", key], "Widget backend data requires a backend entry");
      if (d.source === "native" && !nativeEntry(d.entryId))
        issue([...p, "data", key], "Widget native data needs an unambiguous declared entry");
      if (d.source === "host" && !["text", "number"].includes(d.format))
        issue([...p, "data", key], "host.clock supports text or number data only");
      if (d.source === "backend" || d.source === "native") {
        const a = w.actions[d.subscriptionAction];
        if (!a || a.mode !== "query") {
          issue([...p, "data", key], "Widget subscription must reference a query action");
        } else {
          if (d.source === "backend" && a.entryId)
            issue([...p, "data", key], "Widget backend subscription cannot select a native entry");
          const keys = Object.keys(m.native);
          const selected =
            d.source === "native"
              ? (d.entryId ?? (keys.length === 1 ? keys[0] : "main"))
              : undefined;
          if (
            d.source === "native" &&
            ((a.entryId && a.entryId !== selected) || (!a.entryId && !!m.backend))
          )
            issue([...p, "data", key], "Widget subscription action must select its data source");
        }
      }
    }
    for (const [key, a] of Object.entries(w.actions)) {
      const at = [...p, "actions", key];
      const c = m.commands.find((c) => c.id === a.commandId && !c.internal);
      if (!c || !w.commands.includes(a.commandId)) {
        issue(at, "Widget action must reference an allowed public command");
        continue;
      }
      if (
        c.sourceApplications ||
        c.match === "window" ||
        c.inputs.some((i) => ["files", "image", "window"].includes(i))
      )
        issue(at, "Widget action cannot require a host source or resource context");
      if (a.mode === "open-main") {
        if (!c.window || !Object.hasOwn(m.ui?.windows ?? {}, c.window))
          issue(at, "Widget open-main requires a declared command window");
      } else {
        if (c.window) issue(at, "Widget headless action cannot reference a window command");
        if (a.entryId ? !nativeEntry(a.entryId) : !m.backend && !nativeEntry())
          issue(at, "Widget headless action requires a backend or unambiguous native entry");
      }
    }
  }
}

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
    compatibility: z.strictObject({ kind: z.literal("utools"), manifest: packagePath }).optional(),
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
        widgets: z.record(localId, pluginWidgetSchema).optional(),
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
    refineWidgets(manifest, context);
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
      if (
        command.compatibilityQuery &&
        (!manifest.compatibility || command.id !== "compat-search" || command.search !== "default")
      )
        issue("Compatibility queries require the uTools runtime and its declared provider");
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
            ...(manifest.ui.widgets
              ? {
                  widgets: Object.fromEntries(
                    Object.entries(manifest.ui.widgets).map(([id, widget]) => [
                      id,
                      { ...widget, ...widget.translations?.[language] },
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
