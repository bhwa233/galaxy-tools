import { z } from "zod";

export function utoolsDetailURL(href: string): string | undefined {
  try {
    const url = new URL(href, "https://www.u-tools.cn");
    if (
      url.origin !== "https://www.u-tools.cn" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const match = /^\/plugins\/detail\/([^/]+)\/$/.exec(url.pathname);
    if (!match) return;
    const slug = decodeURIComponent(match[1]!);
    if (
      !slug ||
      /^[.]{1,2}$/.test(slug) ||
      /[/\\]/.test(slug) ||
      [...slug].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return;
    return url.origin + "/plugins/detail/" + encodeURIComponent(slug) + "/";
  } catch {
    return;
  }
}
export function utoolsDownloadURL(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.host !== "res.u-tools.cn" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/plugins\/[a-zA-Z0-9_-]+\.upxs?$/.test(url.pathname)
  )
    throw new Error("uTools 安装包必须来自已支持的官方 HTTPS 下载来源");
  return url.href;
}
export const utoolsSourceIdentitySchema = z.strictObject({
  kind: z.literal("utools"),
  catalogId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  pageURL: z
    .string()
    .max(2048)
    .refine((value) => utoolsDetailURL(value) === value),
});
export const pluginPackageSourceSchema = z
  .strictObject({
    kind: z.enum(["registry", "file", "directory", "utools"]),
    location: z.string(),
    registry: z.string().optional(),
    channel: z.string().optional(),
    catalogId: z.string().max(160).optional(),
    pageURL: z.string().max(2048).optional(),
    upstreamVersion: z.string().max(128).optional(),
    artifactIntegrity: z.string().max(4096).optional(),
    checkedAt: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== "utools") return;
    if (
      !utoolsSourceIdentitySchema.safeParse({
        kind: value.kind,
        catalogId: value.catalogId,
        pageURL: value.pageURL,
      }).success ||
      value.registry ||
      value.channel ||
      !value.artifactIntegrity?.match(/^sha512-[A-Za-z0-9+/]+=*$/) ||
      value.checkedAt === undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "uTools source identity or artifact binding is incomplete",
      });
    try {
      utoolsDownloadURL(value.location);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid uTools download source" });
    }
  });
export type PluginPackageSource = z.infer<typeof pluginPackageSourceSchema>;
export interface RegistryPluginUpdateSource {
  registry: string;
  channel: string;
  kind?: "registry";
}
export type UToolsPluginUpdateSource = z.infer<typeof utoolsSourceIdentitySchema>;
export type PluginUpdateSource = RegistryPluginUpdateSource | UToolsPluginUpdateSource;
