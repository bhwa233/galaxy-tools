import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { atomicWrite, readJson } from "./persistence.js";
import type { LauncherPreferenceMutation } from "../src/features/launcher/types.js";

const targetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    packageName: z.string().min(1).max(214),
    pluginId: z.string().min(1).max(80),
    commandId: z.string().min(1).max(80),
  }),
  z.strictObject({
    kind: z.literal("application"),
    packageName: z.literal("@spark233/plugin-applications"),
    pluginId: z.literal("spark233.applications"),
    applicationId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export type LauncherPreferenceTarget = z.infer<typeof targetSchema>;
const aliasesSchema = z
  .array(z.string().max(80))
  .max(8)
  .transform((values, context) => {
    const seen = new Set<string>();
    return values.map((value) => {
      const alias = value.normalize("NFKC").trim();
      const key = alias.toLocaleLowerCase();
      if (!alias || alias.length > 80 || /\p{Cc}/u.test(alias) || seen.has(key))
        context.addIssue({
          code: "custom",
          message: "别名不能为空、包含控制字符或重复，最长 80 字符",
        });
      seen.add(key);
      return alias;
    });
  });
const entrySchema = z.strictObject({
  target: targetSchema,
  title: z.string().min(1).max(1000),
  description: z.string().max(4000).optional(),
  pinned: z.boolean(),
  hidden: z.boolean(),
  aliases: aliasesSchema,
});
export type SavedLauncherPreference = z.infer<typeof entrySchema>;

/** Short opt-in keywords only; callers decide whether the input is a keyword.
 * Reject control characters before folding whitespace, and never truncate text. */
export function normalizeLearningKeyword(value: unknown): string | undefined {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) return;
  const keyword = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  return keyword && !/\p{Cc}/u.test(keyword) && Array.from(keyword).length <= 32
    ? keyword
    : undefined;
}

const learningSchema = z
  .strictObject({
    enabled: z.boolean(),
    records: z
      .array(
        z.strictObject({
          keyword: z.string().refine((value) => normalizeLearningKeyword(value) === value),
          target: targetSchema,
        }),
      )
      .max(128),
  })
  .refine(
    (value) => new Set(value.records.map((record) => record.keyword)).size === value.records.length,
  );
const usageSchema = z.strictObject({
  pluginId: z.string().min(1).max(80),
  commandId: z.string().min(1).max(80),
  count: z.number().int().min(1).max(1_000_000_000),
  lastUsedAt: z.number().int().nonnegative(),
});
const preferencesSchema = z
  .strictObject({
    onboardingComplete: z.boolean(),
    commandUsage: z.array(usageSchema).max(256).default([]),
    entries: z.array(entrySchema).max(512).default([]),
    learning: learningSchema.default({ enabled: false, records: [] }),
  })
  .superRefine((value, context) => {
    const keys = value.entries.map((entry) => launcherTargetKey(entry.target));
    if (
      new Set(keys).size !== keys.length ||
      value.entries.filter((entry) => entry.pinned).length > 100
    )
      context.addIssue({ code: "custom", message: "入口重复或固定入口超过 100 个" });
  });

/** Stable identity includes package ownership; titles, versions and temporary
 * execution tokens cannot transfer a preference to a different target. */
export function launcherTargetKey(target: LauncherPreferenceTarget): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.kind,
        target.packageName,
        target.pluginId,
        target.kind === "command" ? target.commandId : target.applicationId,
      ]),
    )
    .digest("hex");
}

/** Reuses the host's atomic JSON persistence. A single field-operation writer
 * keeps usage/onboarding saves from erasing pins, aliases or hidden commands. */
export class LauncherPreferences {
  private value: z.infer<typeof preferencesSchema>;
  private learningPolicyRevision = 0;
  constructor(private file: string) {
    this.value = preferencesSchema.parse(
      fs.existsSync(file)
        ? readJson(file)
        : {
            onboardingComplete: false,
            commandUsage: [],
            entries: [],
          },
    );
  }
  get firstRun(): boolean {
    return !this.value.onboardingComplete;
  }
  get usage(): ReadonlyArray<z.infer<typeof usageSchema>> {
    return this.value.commandUsage;
  }
  get learningEnabled(): boolean {
    return this.value.learning.enabled;
  }
  get learningCount(): number {
    return this.value.learning.records.length;
  }
  get learningRevision(): number {
    return this.learningPolicyRevision;
  }
  learningTarget(value: unknown): LauncherPreferenceTarget | undefined {
    if (!this.learningEnabled) return;
    const keyword = normalizeLearningKeyword(value);
    const record =
      keyword && this.value.learning.records.find((entry) => entry.keyword === keyword);
    return record ? structuredClone(record.target) : undefined;
  }
  learn(value: unknown, target: LauncherPreferenceTarget): void {
    if (!this.learningEnabled) return;
    const keyword = normalizeLearningKeyword(value);
    if (!keyword) return;
    const admitted = targetSchema.parse(target);
    this.save({
      ...this.value,
      learning: {
        enabled: true,
        records: [
          { keyword, target: admitted },
          ...this.value.learning.records.filter((entry) => entry.keyword !== keyword),
        ].slice(0, 128),
      },
    });
  }
  setLearningEnabled(value: boolean): void {
    const enabled = z.boolean().parse(value);
    if (enabled === this.learningEnabled) return;
    this.save({ ...this.value, learning: { ...this.value.learning, enabled } });
    this.learningPolicyRevision++;
  }
  clearLearning(): void {
    this.save({ ...this.value, learning: { ...this.value.learning, records: [] } });
    this.learningPolicyRevision++;
  }
  entries(): SavedLauncherPreference[] {
    return structuredClone(this.value.entries);
  }
  find(key: string): SavedLauncherPreference | undefined {
    const entry = this.value.entries.find((entry) => launcherTargetKey(entry.target) === key);
    return entry ? structuredClone(entry) : undefined;
  }
  private save(value: z.infer<typeof preferencesSchema>): void {
    const next = preferencesSchema.parse(value);
    atomicWrite(this.file, JSON.stringify(next));
    this.value = next;
  }
  completeOnboarding(): void {
    this.save({ ...this.value, onboardingComplete: true });
  }
  remember(pluginId: string, commandId: string): void {
    const previous = this.value.commandUsage.find(
      (entry) => entry.pluginId === pluginId && entry.commandId === commandId,
    );
    this.save({
      ...this.value,
      commandUsage: [
        {
          pluginId,
          commandId,
          count: Math.min(1_000_000_000, (previous?.count ?? 0) + 1),
          lastUsedAt: Date.now(),
        },
        ...this.value.commandUsage.filter((entry) => entry !== previous),
      ].slice(0, 256),
    });
  }
  update(
    target: LauncherPreferenceTarget,
    presentation: { title: string; description?: string },
    operation: LauncherPreferenceMutation["operation"],
    aliases?: string[],
  ): void {
    const key = launcherTargetKey(target);
    const entries = this.entries();
    let index = entries.findIndex((entry) => launcherTargetKey(entry.target) === key);
    const previous = entries[index];
    const entry: SavedLauncherPreference = previous ?? {
      target,
      ...presentation,
      pinned: false,
      hidden: false,
      aliases: [],
    };
    if (index < 0) {
      index = entries.length;
      entries.push(entry);
    }
    entry.title = presentation.title;
    entry.description = presentation.description;
    switch (operation) {
      case "pin":
        if (!entry.pinned) {
          entries.splice(index, 1);
          entries.push(entry);
        }
        entry.pinned = true;
        break;
      case "unpin":
        entry.pinned = false;
        break;
      case "aliases":
        entry.aliases = aliasesSchema.parse(aliases);
        break;
      case "hide":
      case "show":
        if (target.kind !== "command") throw new Error("只有公开命令支持隐藏");
        entry.hidden = operation === "hide";
        break;
      case "move-up":
      case "move-down": {
        if (!entry.pinned) throw new Error("只有固定入口支持调整顺序");
        const pinned = entries
          .map((value, index) => ({ value, index }))
          .filter(({ value }) => value.pinned);
        const position = pinned.findIndex(({ value }) => value === entry);
        const other = pinned[position + (operation === "move-up" ? -1 : 1)];
        if (other) [entries[index], entries[other.index]] = [entries[other.index], entries[index]];
        break;
      }
      case "remove":
        entries.splice(index, 1);
        break;
    }
    this.save({ ...this.value, entries });
  }
}
