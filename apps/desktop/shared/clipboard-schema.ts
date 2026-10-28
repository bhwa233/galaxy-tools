import { z } from "zod";
export const settingsSchema = z.strictObject({
  paused: z.boolean(),
  excludedApps: z
    .array(z.string().trim().min(1).max(4096))
    .max(256)
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 48 * 1024,
      "排除应用列表超过原生通信容量",
    ),
  excludedText: z.array(z.string().min(1).max(1000)).max(128),
  retentionDays: z.number().int().min(1).max(36500).nullable(),
  visibleCount: z.number().int().min(1).max(1_000_000).nullable(),
  quickKeys: z.enum(["digits", "function"]).default("digits"),
  quickAction: z.enum(["copy", "paste"]).default("copy"),
  compactPosition: z.enum(["cursor", "edge"]).default("cursor"),
});
