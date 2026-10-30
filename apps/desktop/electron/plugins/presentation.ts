import { nativeImage } from "electron";
import { localizePluginManifest, type PluginTheme } from "@spark233/sdk";
import fs from "node:fs";
import path from "node:path";
import { confined } from "../persistence.js";
import type { PluginManager } from "./manager.js";

const icons = new Map<string, { modified: number; size: number; data: string }>();

/** Only installed, validated package resources become renderer icon data. Never
 * accept an arbitrary icon path from renderer IPC or a plugin-provided URL. */
export function pluginPresentation(
  manager: PluginManager,
  pluginId: string,
  locale: string,
  profile?: string,
  theme?: Pick<PluginTheme, "accent" | "effective">,
) {
  const installation = manager.list().find((item) => item.pluginId === pluginId);
  if (!installation) throw new Error("Plugin is not installed");
  const manifest = localizePluginManifest(manager.describe(pluginId, true).spark233, locale);
  const window =
    profile && Object.hasOwn(manifest.ui?.windows ?? {}, profile)
      ? manifest.ui!.windows![profile]
      : undefined;
  const icon = window?.icon ?? manifest.ui?.icon;
  const resource = theme
    ? (icon?.themes?.[theme.accent ?? "green"]?.[theme.effective] ?? icon)
    : icon;
  const image = resource ? confined(installation.directory, resource.png) : undefined;
  const shellIcon = resource?.ico ? confined(installation.directory, resource.ico) : image;
  let iconData: string | undefined;
  if (image) {
    const stat = fs.statSync(image);
    const cached = icons.get(image);
    if (cached && cached.modified === stat.mtimeMs && cached.size === stat.size)
      iconData = cached.data;
    else {
      const decoded = nativeImage.createFromPath(image);
      const dimensions = decoded.getSize();
      if (decoded.isEmpty() || Math.max(dimensions.width, dimensions.height) > 1024)
        throw new Error("Plugin icon cannot be decoded or exceeds 1024 pixels");
      iconData = decoded.resize({ width: 64, height: 64 }).toDataURL();
      if (icons.size > 256) icons.clear();
      icons.set(image, { modified: stat.mtimeMs, size: stat.size, data: iconData });
    }
  }
  return {
    manifest,
    window,
    title: window?.title ?? manifest.displayName,
    image,
    shellIcon,
    iconData,
    root: installation.directory,
    entry: window
      ? path
          .relative(
            path.join(installation.directory, "renderer"),
            confined(installation.directory, window.entry),
          )
          .split(path.sep)
          .join("/")
      : "index.html",
  };
}
