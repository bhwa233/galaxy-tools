import { z } from "zod";
import type { PluginWidget } from "./manifest.js";
import {
  assertWidgetJson,
  isWidgetRankRows,
  parseWidgetWire,
  sameWidgetBinding,
  type DeclarativeNode,
  type DeclarativeTemplate,
  type WidgetDataFrame,
  type WidgetValue,
  type WidgetBinding,
  type WidgetEnvelope,
} from "./widget.js";

const localId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
  .refine((v) => !["__proto__", "prototype", "constructor"].includes(v), "Reserved widget key");
const finite = z.number().finite().min(-1e15).max(1e15);
const tone = z.enum(["default", "muted", "accent", "warning", "danger", "upload", "download"]);
export const widgetValueSchema = z.union([
  z.string().max(2048),
  finite,
  z.boolean(),
  z.null(),
  z.array(finite).max(120),
  z.custom<import("./widget.js").WidgetRankRow[]>(isWidgetRankRows),
]);
export const widgetDataFrameSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  at: z.number().finite().nonnegative(),
  values: z.record(localId, widgetValueSchema),
});
const nodeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stack"),
    direction: z.enum(["row", "column"]),
    gap: z.union([z.literal(0), z.literal(4), z.literal(8), z.literal(12)]),
    align: z.enum(["start", "center", "end"]),
    children: z.array(z.unknown()).min(1).max(8),
  }),
  z.strictObject({
    type: z.literal("text"),
    value: z.union([
      z.strictObject({ text: z.string().max(160) }),
      z.strictObject({ dataKey: localId }),
    ]),
    size: z.enum(["caption", "body", "title"]),
    tone,
    maxLines: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.strictObject({
    type: z.literal("number"),
    dataKey: localId,
    decimals: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    unit: z.string().max(16).optional(),
    tone,
  }),
  z.strictObject({ type: z.literal("progress"), dataKey: localId, tone }),
  z.strictObject({
    type: z.literal("icon"),
    name: z.enum(["clock", "network", "arrow-up", "arrow-down", "warning"]).optional(),
    dataKey: localId.optional(),
    resourceId: localId.optional(),
    size: z.union([z.literal(16), z.literal(20), z.literal(24)]),
    tone,
  }),
  z.strictObject({
    type: z.literal("sparkline"),
    dataKey: localId,
    min: finite.optional(),
    max: finite.optional(),
    tone,
  }),
  z.strictObject({
    type: z.literal("button"),
    label: z.string().min(1).max(40),
    actionId: localId,
    tone,
  }),
  z.strictObject({ type: z.literal("rank-list"), dataKey: localId, tone }),
]);
const templateSchema = z.strictObject({
  version: z.literal(1),
  padding: z.union([z.literal(0), z.literal(4), z.literal(8), z.literal(12), z.literal(16)]),
  background: z.enum(["card", "transparent"]),
  root: z.unknown(),
});
type TemplateBinding = Pick<PluginWidget, "data" | "actions" | "interactive">;
/** Validate before walking; stacks hold unknown children so Zod never recurses through hostile trees. */
export function parseDeclarativeTemplate(
  value: unknown,
  definition?: TemplateBinding,
): DeclarativeTemplate {
  assertWidgetJson(value, 32 * 1024, 12, 1024);
  const template = templateSchema.parse(value);
  const pending = [{ value: template.root, depth: 1 }];
  let nodes = 0,
    buttons = 0,
    series = 0,
    lists = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 64 || item.depth > 4) throw new Error("Widget template exceeds node/depth limit");
    const node = nodeSchema.parse(item.value);
    if (node.type === "stack") {
      for (const child of node.children) pending.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    if (node.type === "button") {
      if (++buttons > 4) throw new Error("Widget template exceeds button limit");
      if (
        definition &&
        (!definition.interactive ||
          !["action", "open-main"].includes(definition.actions[node.actionId]?.mode))
      )
        throw new Error("Widget button must reference an interactive action");
    }
    if (node.type === "sparkline") {
      if (++series > 4) throw new Error("Widget template exceeds sparkline limit");
      if (node.min !== undefined && node.max !== undefined && node.min >= node.max)
        throw new Error("Widget sparkline minimum must be below maximum");
    }
    if (node.type === "rank-list" && ++lists > 2)
      throw new Error("Widget template exceeds rank-list limit");
    if (
      node.type === "icon" &&
      [node.name, node.dataKey, node.resourceId].filter((v) => v !== undefined).length !== 1
    )
      throw new Error("Widget icon needs exactly one source");
    const key =
      node.type === "text"
        ? "dataKey" in node.value
          ? node.value.dataKey
          : undefined
        : "dataKey" in node
          ? node.dataKey
          : undefined;
    if (key && definition) {
      const expected =
        node.type === "sparkline" ? "series" : node.type === "rank-list" ? "rows" : node.type;
      if (!Object.hasOwn(definition.data, key) || definition.data[key].format !== expected)
        throw new Error(`Widget data binding has incompatible format: ${key}`);
    }
  }
  return template as DeclarativeTemplate;
}
export const declarativeTemplateSchema = z
  .unknown()
  .transform((value, context): DeclarativeTemplate => {
    try {
      return parseDeclarativeTemplate(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid widget template",
      });
      return z.NEVER;
    }
  });
export function declarativeResourceIds(template: DeclarativeTemplate): string[] {
  const pending: DeclarativeNode[] = [template.root];
  const result = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "stack") pending.push(...node.children);
    else if (node.type === "icon" && node.resourceId) result.add(node.resourceId);
  }
  return [...result];
}
export function parseWidgetData(
  value: unknown,
  definition?: Pick<PluginWidget, "data"> | PluginWidget["data"],
): WidgetDataFrame {
  assertWidgetJson(value);
  const parsed = widgetDataFrameSchema.parse(value);
  if (Object.keys(parsed.values).length > 16) throw new Error("Widget data exceeds key limit");
  const nested = definition && "data" in definition ? definition.data : undefined;
  const wrapped = nested && typeof (nested as { source?: unknown }).source !== "string";
  const data = (wrapped ? nested : definition) as PluginWidget["data"] | undefined;
  if (
    data &&
    (Object.keys(parsed.values).length !== Object.keys(data).length ||
      Object.keys(data).some((key) => !Object.hasOwn(parsed.values, key)))
  )
    throw new Error("Widget data must contain exactly the declared keys");
  let samples = 0,
    rows = 0;
  for (const [key, v] of Object.entries(parsed.values)) {
    if (Array.isArray(v) && v.every((item) => typeof item === "number")) samples += v.length;
    else if (isWidgetRankRows(v)) rows += v.length;
    if (samples > 480) throw new Error("Widget data exceeds series sample budget");
    if (rows > 6) throw new Error("Widget data exceeds row budget");
    if (!data || v === null) continue;
    const format = data[key].format;
    if (!matchesFormat(v, format)) throw new Error(`Widget data format mismatch: ${key}`);
  }
  return parsed;
}
export function matchesFormat(
  value: WidgetValue,
  format: PluginWidget["data"][string]["format"],
): boolean {
  if (value === null) return true;
  return format === "text"
    ? typeof value === "string"
    : format === "number"
      ? typeof value === "number"
      : format === "progress"
        ? typeof value === "number" && value >= 0 && value <= 1
        : format === "series"
          ? Array.isArray(value) && value.every((item) => typeof item === "number")
          : format === "rows"
            ? isWidgetRankRows(value)
            : typeof value === "string" &&
              /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) &&
              !["constructor", "prototype", "__proto__"].includes(value);
}
export function parseWidgetEnvelope(wire: unknown, binding?: WidgetBinding): WidgetEnvelope {
  const message = parseWidgetWire(wire);
  if (
    binding &&
    !sameWidgetBinding(binding, {
      pluginId: message.owner.pluginId,
      widgetDefinitionId: message.widgetDefinitionId,
      widgetInstanceId: message.widgetInstanceId,
      owner: message.owner,
      loadGeneration: message.loadGeneration,
    })
  )
    throw new Error("Widget message belongs to a stale binding");
  return message;
}
