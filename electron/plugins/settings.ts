import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "../persistence.js";
import type {
  PluginSettingsField,
  PluginSettingsSnapshot,
} from "../../src/features/plugins/settingsTypes.js";

export interface PluginSettingsAdapter {
  fields: PluginSettingsField[];
  read(): Promise<Record<string, unknown>> | Record<string, unknown>;
  save(values: Record<string, unknown>): Promise<void> | void;
}
/** Existing host/plugin stores remain the owners. This coordinator adds only
 * bounded form validation, opaque revisions and serialized explicit commits. */
export class PluginSettingsService {
  private readonly salt = randomBytes(32);
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly adapter: (id: string) => PluginSettingsAdapter,
    private readonly identity: (id: string) => string,
  ) {}
  private revision(id: string, values: Record<string, unknown>): string {
    return createHmac("sha256", this.salt)
      .update(JSON.stringify([this.identity(id), values]))
      .digest("hex");
  }
  async get(id: string): Promise<PluginSettingsSnapshot> {
    await this.tail.catch(() => {});
    return this.snapshot(id);
  }
  private async snapshot(id: string): Promise<PluginSettingsSnapshot> {
    const adapter = this.adapter(id),
      values = await adapter.read();
    const sanitized = { ...values };
    let hasSecret = false;
    for (const field of adapter.fields)
      if (field.type === "secret") {
        hasSecret ||= !!values[field.key];
        delete sanitized[field.key];
      }
    return {
      pluginId: id,
      revision: this.revision(id, values),
      fields: adapter.fields,
      values: sanitized,
      hasSecret,
    };
  }
  save(id: string, revision: string, patch: unknown): Promise<PluginSettingsSnapshot> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        const adapter = this.adapter(id),
          current = await adapter.read();
        if (revision !== this.revision(id, current))
          throw new AppError("settingsConflict", "配置已发生变化，请重新加载并核对后保存");
        if (
          !patch ||
          typeof patch !== "object" ||
          Array.isArray(patch) ||
          Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024
        )
          throw new AppError("invalidPayload", "插件配置格式不合法");
        const parsed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch)) {
          const field = adapter.fields.find((item) => item.key === key);
          if (!field) throw new AppError("invalidPayload", "插件配置包含不支持的字段");
          let schema: z.ZodType =
            field.type === "boolean"
              ? z.boolean()
              : field.type === "number"
                ? z
                    .number()
                    .min(field.min ?? 0)
                    .max(field.max ?? 1000000)
                : field.type === "lines"
                  ? z.array(z.string().max(32768)).max(256)
                  : field.type === "select"
                    ? z.enum(field.options as [string, ...string[]])
                    : z.string().max(field.type === "secret" ? 8192 : 32768);
          if (field.nullable) schema = schema.nullable();
          const result = schema.safeParse(value);
          if (!result.success) throw new AppError("invalidPayload", `配置字段不合法：${key}`);
          parsed[key] = result.data;
        }
        await adapter.save({ ...current, ...parsed });
        return this.snapshot(id);
      });
    this.tail = operation;
    return operation;
  }
}
