import fs from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../persistence.js";

const provider = z.strictObject({
  endpoint: z.string().max(2048),
  model: z.string().trim().min(1).max(200),
  key: z
    .string()
    .max(8192)
    .refine((key) => !/[\r\n]/.test(key)),
});
export function validateTranslationSettings(value: unknown): z.infer<typeof provider> {
  const parsed = provider.parse(value),
    url = new URL(parsed.endpoint);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("服务地址必须使用 HTTPS 或本机 HTTP，且不能包含鉴权、查询参数或片段");
  if (!url.pathname.replace(/\/$/, "").endsWith("/chat/completions"))
    url.pathname = url.pathname.replace(/\/$/, "") + "/chat/completions";
  return { ...parsed, endpoint: url.href };
}
export function readTranslationSettings(
  file: string,
  decrypt: (bytes: Buffer) => string,
): Record<string, unknown> {
  if (!fs.existsSync(file)) return { endpoint: "", model: "", key: "" };
  const saved = z
    .strictObject({ endpoint: z.string(), model: z.string(), protectedKey: z.string() })
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return {
    endpoint: saved.endpoint,
    model: saved.model,
    key: saved.protectedKey ? decrypt(Buffer.from(saved.protectedKey, "base64")) : "",
  };
}
export function writeTranslationSettings(
  file: string,
  value: unknown,
  encrypt: (text: string) => Buffer,
): void {
  const config = validateTranslationSettings(value);
  atomicWrite(
    file,
    JSON.stringify({
      endpoint: config.endpoint,
      model: config.model,
      protectedKey: config.key ? encrypt(config.key).toString("base64") : "",
    }),
  );
}
