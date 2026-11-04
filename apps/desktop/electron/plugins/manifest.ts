import fs from "node:fs";
import semver from "semver";
import npa from "npm-package-arg";
import {
  HOST_API_VERSION,
  THEME_API_VERSION,
  pluginPackageSchema,
  parseDeclarativeTemplate,
  declarativeResourceIds,
  type DeclarativeTemplate,
  type PluginPackageMetadata,
} from "@spark233/sdk";
import { AppError, canonical, confined, inside } from "../persistence.js";
import { compatibilityManifest } from "./utools-manifest.js";

export interface HostEnvironment {
  version: string;
  apiVersion: string;
  platform: string;
  arch: string;
}
export interface PluginExpectation {
  name?: string;
  version?: string;
  pluginId?: string;
}
export interface ResolvedPluginEntries {
  web?: string;
  backend?: { entry: string };
  migration?: { entry: string };
  native: Record<string, { path: string; args: string[] }>;
  widgets: Record<string, ResolvedWidgetEntry>;
}
export type ResolvedWidgetEntry =
  | { kind: "web"; file: string; root: string }
  | {
      kind: "declarative";
      template: DeclarativeTemplate;
      hoverTemplate?: DeclarativeTemplate;
      root: string;
      resources: Record<string, string>;
    };
export function defaultHostEnvironment(version: string): HostEnvironment {
  return { version, apiVersion: HOST_API_VERSION, platform: process.platform, arch: process.arch };
}

/** This same validation is used for registry metadata and the extracted package. */
export function validatePluginMetadata(
  value: unknown,
  environment: HostEnvironment,
  expected: PluginExpectation = {},
  options: { allowIncompatibleHost?: boolean } = {},
): PluginPackageMetadata {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
      throw new Error("metadata exceeds size limit");
  } catch {
    throw new AppError("invalidPlugin", "插件清单超过大小限制或不是 JSON");
  }
  const parsed = pluginPackageSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("invalidPlugin", "插件清单不符合 spark233 合同", {
      issues: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
  }
  const metadata = parsed.data;
  const manifest = metadata.spark233;
  if (manifest.compatibility && !semver.subset(manifest.api, ">=1.6.0 <2.0.0"))
    throw new AppError("incompatiblePlugin", "uTools 兼容运行时要求最低 API 1.6.0");
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.name)) {
    throw new AppError("invalidPlugin", "插件 npm 包名不合法");
  }
  const specifier = npa.resolve(metadata.name, metadata.version);
  if (specifier.type !== "version" || semver.valid(metadata.version) !== metadata.version) {
    throw new AppError("invalidPlugin", "插件包必须具有确切的语义版本");
  }
  if (
    (expected.name !== undefined && metadata.name !== expected.name) ||
    (expected.version !== undefined && metadata.version !== expected.version) ||
    (expected.pluginId !== undefined && manifest.id !== expected.pluginId)
  )
    throw new AppError("pluginIdentityMismatch", "插件包名、版本或插件身份与预期不一致");

  for (const value of [
    manifest.api,
    manifest.host,
    ...Object.values(manifest.dependencies),
    ...Object.values(manifest.optionalDependencies),
    ...(manifest.ui ? [manifest.ui.theme] : []),
  ]) {
    if (!semver.validRange(value)) throw new AppError("invalidPlugin", "插件兼容范围不合法");
  }
  if (
    !semver.satisfies(environment.apiVersion, manifest.api) ||
    (!options.allowIncompatibleHost && !semver.satisfies(environment.version, manifest.host))
  ) {
    console.error("plugin-incompatible-debug", {
      environment,
      api: manifest.api,
      host: manifest.host,
    });
    throw new AppError("incompatiblePlugin", "插件与当前宿主版本不兼容");
  }
  if (
    Object.values(manifest.ui?.windows ?? {}).some((window) => window.titleBar === "custom") &&
    !semver.subset(manifest.api, ">=1.5.0 <2.0.0")
  )
    throw new AppError("incompatiblePlugin", "自定义窗口标题栏要求最低 API 1.5.0");
  if (
    Object.keys(manifest.ui?.widgets ?? {}).length &&
    !semver.subset(manifest.api, ">=1.4.0 <2.0.0")
  )
    throw new AppError(
      "incompatiblePlugin",
      "桌面卡片要求最低 API 1.4.0，且兼容范围不得包含旧 API",
    );
  if (
    (manifest.ui?.icon ||
      Object.keys(manifest.ui?.windows ?? {}).length ||
      manifest.commands.some(
        (command) => command.launcher || command.window || command.progress,
      )) &&
    !semver.subset(manifest.host, ">=0.0.1")
  )
    throw new AppError("incompatiblePlugin", "插件窗口声明需要声明最低宿主版本 0.0.1");
  if (
    !manifest.platforms.some((platform) => platform === environment.platform) ||
    !manifest.architectures.some((arch) => arch === environment.arch)
  ) {
    throw new AppError("incompatiblePlugin", "插件不支持当前平台或架构");
  }
  if (manifest.ui && !semver.satisfies(THEME_API_VERSION, manifest.ui.theme)) {
    throw new AppError("incompatiblePlugin", "插件主题协议与当前宿主不兼容");
  }
  for (const id of Object.keys(manifest.dependencies)) {
    if (Object.hasOwn(manifest.optionalDependencies, id))
      throw new AppError("invalidPlugin", "必需与可选插件依赖不能重复");
  }
  return metadata;
}

export function resolvePluginEntries(
  directory: string,
  metadata: PluginPackageMetadata,
): ResolvedPluginEntries {
  const root = canonical(directory);
  if (!fs.statSync(root).isDirectory()) throw new AppError("invalidPlugin", "插件根路径不是目录");
  const entry = (relative: string, extensions: RegExp) => {
    const target = confined(root, relative);
    const real = fs.realpathSync(target);
    if (!inside(root, real) || !fs.statSync(real).isFile() || !extensions.test(real)) {
      throw new AppError("invalidPlugin", "插件入口不合法或超出包目录");
    }
    return real;
  };
  const icon = (
    value: NonNullable<NonNullable<PluginPackageMetadata["spark233"]["ui"]>["icon"]>,
  ) => {
    for (const resource of [
      value,
      ...Object.values(value.themes ?? {}).flatMap((theme) => [theme.light, theme.dark]),
    ])
      for (const format of ["png", "ico"] as const) {
        const relative = resource[format];
        if (!relative) continue;
        const file = entry(relative, format === "png" ? /\.png$/i : /\.ico$/i);
        const bytes = fs.readFileSync(file);
        if (
          bytes.length > 1024 * 1024 ||
          (format === "png"
            ? !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : !bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])))
        )
          throw new AppError("invalidPlugin", "插件图标格式不合法或超过大小限制");
        if (
          format === "png" &&
          (bytes.length < 24 || bytes.readUInt32BE(16) > 1024 || bytes.readUInt32BE(20) > 1024)
        )
          throw new AppError("invalidPlugin", "插件图标超过 1024 像素");
      }
  };
  if (metadata.spark233.ui?.icon) icon(metadata.spark233.ui.icon);
  for (const window of Object.values(metadata.spark233.ui?.windows ?? {})) {
    entry(window.entry, /\.html$/i);
    if (window.icon) icon(window.icon);
  }
  const widgets: Record<string, ResolvedWidgetEntry> = {};
  for (const [id, widget] of Object.entries(metadata.spark233.ui?.widgets ?? {})) {
    const relative = widget.kind === "web" ? widget.entry : widget.template;
    const file = entry(relative, widget.kind === "web" ? /\.html$/i : /\.json$/i);
    // Resources are confined to this widget's package directory, including links.
    const widgetRoot = confined(root, "widgets");
    if (widget.kind === "web") {
      if (fs.statSync(file).size > 32 * 1024 * 1024)
        throw new AppError("invalidPlugin", "桌面卡片 HTML 超过大小限制");
      widgets[id] = { kind: "web", file, root: widgetRoot };
    } else {
      if (fs.statSync(file).size > 32 * 1024)
        throw new AppError("invalidPlugin", "声明式卡片模板超过大小限制");
      let template: DeclarativeTemplate;
      try {
        template = parseDeclarativeTemplate(JSON.parse(fs.readFileSync(file, "utf8")), widget);
      } catch (error) {
        throw new AppError("invalidPlugin", "声明式卡片模板不合法", {
          issues: error instanceof Error ? error.message : String(error),
        });
      }
      let hoverTemplate: DeclarativeTemplate | undefined;
      const hoverRelative = widget.desktopInteractions?.hover?.template;
      if (hoverRelative) {
        const hoverFile = entry(hoverRelative, /\.json$/i);
        if (fs.statSync(hoverFile).size > 32 * 1024)
          throw new AppError("invalidPlugin", "悬停卡片模板超过大小限制");
        try {
          hoverTemplate = parseDeclarativeTemplate(
            JSON.parse(fs.readFileSync(hoverFile, "utf8")),
            widget,
          );
        } catch (error) {
          throw new AppError("invalidPlugin", "悬停卡片模板不合法", { issues: String(error) });
        }
      }
      const resources: Record<string, string> = {};
      for (const [source, parsed] of [
        [relative, template],
        ...(hoverTemplate && hoverRelative ? [[hoverRelative, hoverTemplate] as const] : []),
      ] as const) {
        for (const resourceId of declarativeResourceIds(parsed)) {
          const png = entry(
            source.replace(/\.json$/i, "") + "/icons/" + resourceId + ".png",
            /\.png$/i,
          );
          const bytes = fs.readFileSync(png);
          if (
            bytes.length < 24 ||
            bytes.length > 64 * 1024 ||
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.readUInt32BE(16) < 1 ||
            bytes.readUInt32BE(20) < 1 ||
            bytes.readUInt32BE(16) > 256 ||
            bytes.readUInt32BE(20) > 256
          )
            throw new AppError("invalidPlugin", "桌面卡片 PNG 资源不合法或超过大小限制");
          if (resources[resourceId] && !fs.readFileSync(resources[resourceId]).equals(bytes))
            throw new AppError("invalidPlugin", "桌面卡片图标标识冲突");
          resources[resourceId] = png;
        }
      }
      widgets[id] = { kind: "declarative", template, hoverTemplate, root: widgetRoot, resources };
    }
  }
  return {
    widgets,
    ...(metadata.spark233.entry ? { web: entry(metadata.spark233.entry, /\.html$/i) } : {}),
    ...(metadata.spark233.backend
      ? { backend: { entry: entry(metadata.spark233.backend.entry, /\.(?:mjs|cjs|js)$/i) } }
      : {}),
    ...(metadata.spark233.migration
      ? { migration: { entry: entry(metadata.spark233.migration.entry, /\.(?:mjs|cjs|js)$/i) } }
      : {}),
    native: Object.fromEntries(
      Object.entries(metadata.spark233.native).map(([id, descriptor]) => [
        id,
        {
          path: entry(descriptor.path, /\.exe$/i),
          args: [...descriptor.args],
        },
      ]),
    ),
  };
}

export function validatePluginDirectory(
  directory: string,
  environment: HostEnvironment,
  expected?: PluginExpectation,
  options: { allowIncompatibleHost?: boolean } = {},
): PluginPackageMetadata {
  const manifestFile = confined(directory, "package.json");
  if (!fs.statSync(manifestFile).isFile() || fs.statSync(manifestFile).size > 256 * 1024) {
    throw new AppError("invalidPlugin", "插件 package.json 不是文件或超过大小限制");
  }
  const metadata = validatePluginMetadata(
    JSON.parse(fs.readFileSync(manifestFile, "utf8")),
    environment,
    expected,
    options,
  );
  resolvePluginEntries(directory, metadata);
  if (metadata.spark233.compatibility) compatibilityManifest(directory, metadata);
  return metadata;
}
