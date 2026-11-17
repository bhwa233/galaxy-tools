import {
  localizePluginManifest,
  pluginWindowPageEntry,
  type PluginIcon,
  type PluginManifest,
  type PluginWidget,
  type PluginWindow,
} from "@spark233/sdk";

export interface ResolvedWindowDefinition {
  pluginId: string;
  windowId: string;
  pluginTitle: string;
  title: string;
  icon?: PluginIcon;
  content: { kind: "page"; entry: string } | PluginWidget;
  /** Restricted widget pages retain the widget bridge, even in a unified catalog. */
  bridge: "page" | "widget" | "utools";
  legacyWidget: boolean;
  cardDesktop: boolean;
  purpose: "business" | "dialog";
  chrome: "host" | "none";
  reuse: "singleton" | "document" | "multiple";
  size: { width: number; height: number };
  minSize: { width: number; height: number };
  maxSize: { width: number; height: number };
  resizable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  taskbar: boolean;
  create?: PluginWindow["create"];
  restore?: PluginWindow["restore"];
}

/** Reuse validated SDK declarations and localization. No command is inferred to
 * be a window; no installed HTML page is inferred to support the card desktop. */
export function pluginWindowCatalog(
  source: PluginManifest,
  locale = "zh-CN",
): ResolvedWindowDefinition[] {
  const manifest = localizePluginManifest(source, locale);
  const result: ResolvedWindowDefinition[] = [];
  if (manifest.compatibility && manifest.entry)
    result.push({
      pluginId: manifest.id,
      windowId: "utools-main",
      pluginTitle: manifest.displayName,
      title: manifest.displayName,
      icon: manifest.ui?.icon,
      content: { kind: "page", entry: manifest.entry },
      bridge: "utools",
      legacyWidget: false,
      cardDesktop: true,
      purpose: "business",
      chrome: "host",
      reuse: "singleton",
      size: { width: 800, height: 600 },
      minSize: { width: 320, height: 200 },
      maxSize: { width: 8192, height: 8192 },
      resizable: true,
      minimizable: true,
      maximizable: true,
      taskbar: true,
      restore: { parameterVersion: 1 },
    });
  for (const [windowId, window] of Object.entries(manifest.ui?.windows ?? {})) {
    const entry = pluginWindowPageEntry(window);
    const content = window.content ?? (entry ? { kind: "page" as const, entry } : undefined);
    if (!content) throw new Error(`Window has no content: ${manifest.id}/${windowId}`);
    const widget = content.kind === "page" ? undefined : content;
    result.push({
      pluginId: manifest.id,
      windowId,
      pluginTitle: manifest.displayName,
      title: window.title ?? widget?.title ?? manifest.displayName,
      icon: window.icon ?? manifest.ui?.icon,
      content,
      bridge: widget ? "widget" : "page",
      legacyWidget: false,
      cardDesktop: window.cardDesktop === true && window.purpose !== "dialog",
      purpose: window.purpose ?? "business",
      chrome: window.chrome ?? "host",
      reuse: window.reuse ?? "singleton",
      size: window.size ?? widget?.size ?? { width: 800, height: 600 },
      minSize:
        window.minSize ??
        widget?.minSize ??
        (widget ? { width: 80, height: 32 } : { width: 160, height: 60 }),
      maxSize:
        window.maxSize ??
        widget?.maxSize ??
        (widget ? { width: 1200, height: 900 } : { width: 8192, height: 8192 }),
      resizable: window.resizable ?? widget?.resizable ?? true,
      minimizable: window.minimizable ?? true,
      maximizable: window.maximizable ?? !widget,
      taskbar: window.taskbar ?? !widget,
      create: window.create,
      restore: window.restore,
    });
  }
  for (const [windowId, widget] of Object.entries(manifest.ui?.widgets ?? {})) {
    if (result.some((window) => window.windowId === windowId))
      throw new Error(`Duplicate window/widget ID: ${manifest.id}/${windowId}`);
    // Both legacy widget carriers already implement desktop-layer presentation.
    // Preserve their restricted bridge and explicit template/action declarations.
    result.push({
      pluginId: manifest.id,
      windowId,
      pluginTitle: manifest.displayName,
      title: widget.title,
      icon: manifest.ui?.icon,
      content: widget,
      bridge: "widget",
      legacyWidget: true,
      cardDesktop: true,
      purpose: "business",
      chrome: "none",
      reuse: "multiple",
      size: widget.size,
      minSize: widget.minSize ?? { width: 80, height: 32 },
      maxSize: widget.maxSize ?? { width: 1200, height: 900 },
      resizable: widget.resizable,
      minimizable: false,
      maximizable: false,
      taskbar: false,
    });
  }
  return result;
}
