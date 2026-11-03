import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import semver from "semver";
import { z } from "zod";
import {
  isPluginPackagePath,
  pluginPackageSchema,
  type PluginPackageMetadata,
} from "@spark233/sdk";
import { confined, inside } from "../persistence.js";

const relative = z.string().max(512).refine(isPluginPackagePath);
const pattern = z.string().max(1024);
const rule = z.object({
  type: z.enum(["regex", "over", "img", "files", "window"]),
  label: z.string().min(1).max(160),
  match: z.union([pattern, z.record(z.string(), z.unknown())]).optional(),
  exclude: pattern.optional(),
  fileType: z.enum(["file", "directory"]).optional(),
  extensions: z.array(z.string().max(32)).max(100).optional(),
  minLength: z.number().int().nonnegative().max(100000).optional(),
  maxLength: z.number().int().nonnegative().max(100000).optional(),
});
export const utoolsFeatureSchema = z.object({
  code: z.string().min(1).max(160),
  explain: z.string().max(500).optional(),
  description: z.string().max(500).optional(),
  mainPush: z.boolean().optional(),
  mainHide: z.boolean().optional(),
  platform: z
    .array(z.enum(["win32", "darwin", "linux"]))
    .min(1)
    .max(3)
    .optional(),
  cmds: z
    .array(z.union([z.string().min(1).max(160), rule]))
    .min(1)
    .max(32),
});
export const utoolsManifestSchema = z.object({
  name: z.string().min(1).max(214).optional(),
  pluginName: z.string().min(1).max(160).optional(),
  version: z.string().max(128).optional(),
  main: z.preprocess((value) => (value === "" ? undefined : value), relative.optional()),
  preload: relative.optional(),
  logo: relative.optional(),
  platform: z
    .array(z.enum(["win32", "darwin", "linux"]))
    .min(1)
    .max(3)
    .optional(),
  features: z.array(utoolsFeatureSchema).min(1).max(100),
  pluginSetting: z
    .object({ single: z.boolean().optional(), height: z.number().min(60).max(4000).optional() })
    .optional(),
});
export type UToolsManifest = z.infer<typeof utoolsManifestSchema>;
export type UToolsFeature = z.infer<typeof utoolsFeatureSchema>;
export function utoolsCommandId(code: string): string {
  return "feature-" + createHash("sha256").update(code).digest("hex").slice(0, 24);
}

export function readUToolsManifest(root: string, relativePath = "plugin.json"): UToolsManifest {
  const filename = confined(root, relativePath);
  if (
    !inside(fs.realpathSync(root), fs.realpathSync(filename)) ||
    fs.statSync(filename).size > 128 * 1024
  )
    throw new Error("uTools 清单超出包目录或大小限制");
  const manifest = utoolsManifestSchema.parse(
    JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")),
  );
  if (!manifest.main && !manifest.preload) throw new Error("uTools 插件缺少 main 或 preload");
  if (new Set(manifest.features.map((f) => f.code)).size !== manifest.features.length)
    throw new Error("uTools 功能编码重复");
  const base = path.dirname(filename);
  for (const [kind, entry] of Object.entries({
    main: manifest.main,
    preload: manifest.preload,
    logo: manifest.logo,
  })) {
    if (!entry) continue;
    const file = confined(base, entry);
    if (!inside(fs.realpathSync(base), fs.realpathSync(file)) || !fs.statSync(file).isFile())
      throw new Error("uTools 入口超出包目录: " + kind);
    if (kind === "main" && !/\.html?$/i.test(entry)) throw new Error("uTools main 必须是本地 HTML");
    if (kind === "preload" && !/\.(?:c?js)$/i.test(entry))
      throw new Error("uTools preload 必须是 JavaScript");
  }
  return manifest;
}

/** Reuse the validated directory snapshot and existing npm install transaction.
 * uTools supplies a different manifest, not an interchangeable npm runtime. */
export async function normalizeUToolsPackage(root: string): Promise<void> {
  const packageFile = path.join(root, "package.json");
  if (fs.existsSync(packageFile) && fs.statSync(packageFile).size > 256 * 1024)
    throw new Error("package.json 超过 256 KB");
  const pkg = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, "utf8")) : {};
  if (pkg.spark233 || !fs.existsSync(path.join(root, "plugin.json"))) return;
  const manifest = readUToolsManifest(root);
  const identity = manifest.name || pkg.name || manifest.pluginName;
  if (typeof identity !== "string" || !identity.trim())
    throw new Error(
      "uTools 插件需要稳定身份：请在构建目录保留 package.json 的 name 或 plugin.json 的 name/pluginName",
    );
  const id = "utools." + createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const displayName = (manifest.pluginName || pkg.description || identity).slice(0, 160);
  const baseVersion = semver.valid(manifest.version || pkg.version || "0.0.0");
  if (!baseVersion) throw new Error("uTools 插件版本不是有效的语义版本");
  const fingerprint = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        fingerprint.update(path.relative(root, file).replaceAll("\\", "/") + "\0");
        fingerprint.update(fs.readFileSync(file));
      }
    }
  };
  walk(root);
  const version =
    baseVersion.split("+")[0] +
    (baseVersion.includes("-") ? "." : "-") +
    "utools.h" +
    fingerprint.digest("hex").slice(0, 16);
  const supportedFeatures = manifest.features.filter(
    (feature) => !feature.platform || feature.platform.includes(process.platform as "win32"),
  );
  const firstEntry = supportedFeatures.find((feature) =>
    feature.cmds.some((command) => typeof command === "string"),
  );
  const metadata = pluginPackageSchema.parse({
    name: "@spark233-utools/" + id.slice(7),
    version,
    description: "uTools 兼容插件 · 本地运行，不含账号、付费与云同步",
    spark233: {
      schemaVersion: 1,
      id,
      displayName,
      api: ">=1.6.0 <2.0.0",
      host: ">=0.0.1 <1",
      platforms: manifest.platform || ["win32", "darwin", "linux"],
      architectures: ["x64", "arm64"],
      entry: "payload/" + (manifest.main || "spark233-empty.html"),
      compatibility: { kind: "utools", manifest: "payload/plugin.json" },
      ...(manifest.logo?.toLowerCase().endsWith(".png")
        ? { ui: { theme: "^1.0.0", icon: { png: "payload/" + manifest.logo } } }
        : {}),
      capabilities: [
        "node.backend",
        "storage",
        "files.read",
        "files.write",
        "clipboard.read",
        "clipboard.write",
        "notifications",
        "windows",
        "network",
      ],
      commands: [
        ...supportedFeatures.map((feature) => ({
          id: utoolsCommandId(feature.code),
          title: (
            feature.explain ||
            feature.description ||
            feature.cmds.find((c) => typeof c === "string") ||
            feature.code
          )
            .toString()
            .slice(0, 160),
          keywords: feature.cmds
            .filter((c): c is string => typeof c === "string")
            .map((c) => c.slice(0, 80)),
          launcher: {
            role: feature.cmds.some((c) => typeof c === "string")
              ? feature === firstEntry
                ? "entry"
                : "action"
              : "hidden",
          },
        })),
        {
          id: "compat-search",
          title: displayName,
          search: "default",
          compatibilityQuery: "utools",
          inputs: ["text", "files", "image"],
          launcher: { role: "hidden" },
        },
        { id: "compat-dispatch", title: displayName, launcher: { role: "hidden" } },
      ],
    },
  });
  const previous = root + ".utools";
  await fs.promises.rename(root, previous);
  await fs.promises.mkdir(root);
  await fs.promises.rename(previous, path.join(root, "payload"));
  if (!manifest.main)
    await fs.promises.writeFile(
      path.join(root, "payload/spark233-empty.html"),
      "<!doctype html><html><body></body></html>",
    );
  await fs.promises.writeFile(packageFile, JSON.stringify(metadata, null, 2));
}

export function compatibilityManifest(
  directory: string,
  metadata: PluginPackageMetadata,
): UToolsManifest {
  const config = metadata.spark233.compatibility;
  if (!config) throw new Error("插件不是 uTools 兼容类型");
  return readUToolsManifest(directory, config.manifest);
}
