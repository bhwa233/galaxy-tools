import fs from "node:fs";
import semver from "semver";
import npa from "npm-package-arg";
import {
  HOST_API_VERSION,
  THEME_API_VERSION,
  pluginPackageSchema,
  type PluginPackageMetadata,
} from "@spark233/sdk";
import { AppError, canonical, confined, inside } from "../persistence.js";

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
}
export function defaultHostEnvironment(version: string): HostEnvironment {
  return { version, apiVersion: HOST_API_VERSION, platform: process.platform, arch: process.arch };
}

/** This same validation is used for registry metadata and the extracted package. */
export function validatePluginMetadata(
  value: unknown,
  environment: HostEnvironment,
  expected: PluginExpectation = {},
): PluginPackageMetadata {
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
    !semver.satisfies(environment.version, manifest.host)
  ) {
    throw new AppError("incompatiblePlugin", "插件与当前宿主版本不兼容");
  }
  if (
    (manifest.ui?.icon ||
      Object.keys(manifest.ui?.windows ?? {}).length ||
      manifest.commands.some(
        (command) => command.launcher || command.window || command.progress,
      )) &&
    !semver.subset(manifest.host, ">=1.3.0")
  )
    throw new AppError("incompatiblePlugin", "插件窗口声明需要声明最低宿主版本 1.3.0");
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
  return {
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
): PluginPackageMetadata {
  const manifestFile = confined(directory, "package.json");
  if (!fs.statSync(manifestFile).isFile() || fs.statSync(manifestFile).size > 256 * 1024) {
    throw new AppError("invalidPlugin", "插件 package.json 不是文件或超过大小限制");
  }
  const metadata = validatePluginMetadata(
    JSON.parse(fs.readFileSync(manifestFile, "utf8")),
    environment,
    expected,
  );
  resolvePluginEntries(directory, metadata);
  return metadata;
}
