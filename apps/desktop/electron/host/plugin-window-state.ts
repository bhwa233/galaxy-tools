import fs from "node:fs";
import { z } from "zod";
import { windowBindingSchema } from "@spark233/sdk";
import { AppError, atomicWrite, readJson } from "../persistence.js";

const identity = z.string().min(1).max(200);
const environment = z.enum(["desktop", "card-desktop"]);
const geometry = z.strictObject({
  x: z.number().finite().min(-10_000_000).max(10_000_000),
  y: z.number().finite().min(-10_000_000).max(10_000_000),
  width: z.number().int().min(32).max(32768),
  height: z.number().int().min(32).max(32768),
});
const instanceSchema = z.strictObject({
  id: z.uuid(),
  pluginId: identity,
  binding: windowBindingSchema,
  autoRestore: z.boolean().optional(),
});
const placementSchema = z
  .strictObject({
    id: z.uuid(),
    instanceId: z.uuid(),
    environment,
    bounds: geometry,
    visible: z.boolean(),
    order: z.number().int().nonnegative().safe(),
    topmost: z.boolean().optional(),
    displayId: identity.optional(),
  })
  .superRefine((placement, ctx) => {
    if (
      placement.environment === "card-desktop" &&
      (placement.topmost !== undefined || placement.displayId !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Card placements cannot own topmost or display state",
      });
  });
const createIntentSchema = z.strictObject({
  id: z.uuid(),
  pluginId: identity,
  windowId: identity,
  environment,
  bounds: geometry,
  binding: windowBindingSchema.optional(),
});
const cleanupSchema = z.strictObject({
  id: z.uuid(),
  pluginId: identity,
  contentId: identity.optional(),
  confirmed: z.boolean(),
  instanceIds: z.array(z.uuid()).max(4096).optional(),
  creationIds: z.array(z.uuid()).max(512).optional(),
});
export const pluginWindowLayoutSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    instances: z.array(instanceSchema).max(4096),
    placements: z.array(placementSchema).max(8192),
    pendingCreates: z.array(createIntentSchema).max(512),
    cleanup: z.array(cleanupSchema).max(512),
    cardDesktop: z.strictObject({ hiddenPlugins: z.array(identity).max(4096) }),
    migration: z
      .strictObject({
        version: z.number().int().nonnegative(),
        sources: z.array(identity).max(32),
        removedCards: z.array(identity).max(4096).optional(),
        warnings: z.array(z.string().max(500)).max(512).optional(),
      })
      .optional(),
  })
  .superRefine((state, ctx) => {
    const unique = (values: string[], name: string) => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: "custom", message: "Duplicate " + name });
    };
    unique(
      state.instances.map((value) => value.id),
      "window instance",
    );
    unique(
      state.placements.map((value) => value.id),
      "placement",
    );
    unique(
      state.placements.map((value) => JSON.stringify([value.instanceId, value.environment])),
      "instance/environment placement",
    );
    unique(
      state.pendingCreates.map((value) => value.id),
      "creation intent",
    );
    unique(
      state.cleanup.map((value) => value.id),
      "cleanup intent",
    );
    const instances = new Set(state.instances.map((value) => value.id));
    if (state.placements.some((value) => !instances.has(value.instanceId)))
      ctx.addIssue({ code: "custom", message: "Placement references an unknown instance" });
    if (
      state.pendingCreates.some(
        (value) => value.binding && value.binding.windowId !== value.windowId,
      )
    )
      ctx.addIssue({ code: "custom", message: "Creation result does not match its window" });
  });
export type PluginWindowLayout = z.infer<typeof pluginWindowLayoutSchema>;
export type WindowInstanceRecord = PluginWindowLayout["instances"][number];
export type WindowPlacementRecord = PluginWindowLayout["placements"][number];

/** Reuse atomicWrite and damaged-file protection from the legacy geometry store.
 * Commit the validated snapshot before publishing it; failed writes keep memory
 * and disk at the same revision instead of silently losing a placement. */
export class PluginWindowLayoutStore {
  private state: PluginWindowLayout = {
    version: 1,
    revision: 0,
    instances: [],
    placements: [],
    pendingCreates: [],
    cleanup: [],
    cardDesktop: { hiddenPlugins: [] },
  };
  readError?: unknown;
  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > 8 * 1024 * 1024)
          throw new Error("Window layout exceeds 8 MiB");
        this.state = pluginWindowLayoutSchema.parse(readJson(file));
      }
    } catch (error) {
      this.readError = error;
    }
  }
  load(): PluginWindowLayout {
    return structuredClone(this.state);
  }
  reload(): void {
    const next = new PluginWindowLayoutStore(this.file);
    if (next.readError)
      throw new AppError("window.layoutUnreadable", "恢复的窗口布局无法读取，原文件已保留");
    this.state = next.load();
    this.readError = undefined;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private listeners = new Set<() => void>();
  commit(change: (state: PluginWindowLayout) => void): PluginWindowLayout {
    if (this.readError)
      throw new AppError("window.layoutUnreadable", "窗口布局无法读取，原文件已保留");
    const next = this.load();
    change(next);
    next.revision = this.state.revision + 1;
    const checked = pluginWindowLayoutSchema.parse(next);
    const serialized = JSON.stringify(checked);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw new AppError("window.layoutLimit", "窗口布局超过大小限制");
    atomicWrite(this.file, serialized);
    this.state = checked;
    for (const listener of this.listeners) listener();
    return this.load();
  }
}

const stateSchema = z
  .array(
    z.strictObject({
      pluginId: z.string().min(1).max(80),
      profile: z.string().min(1).max(80),
      bounds: z.strictObject({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().int().min(160).max(8192),
        height: z.number().int().min(60).max(8192),
      }),
      topmost: z.boolean(),
    }),
  )
  .max(512);
type State = z.infer<typeof stateSchema>[number];

/** Geometry is host state, independent of the notes plugin's database. Reuse the
 * existing atomic writer; an unreadable file is preserved and never overwritten. */
export class PluginWindowStateStore {
  private states = new Map<string, State>();
  readonly readError?: unknown;
  constructor(private file: string) {
    try {
      if (fs.existsSync(file))
        for (const state of stateSchema.parse(readJson(file)))
          this.states.set(JSON.stringify([state.pluginId, state.profile]), state);
    } catch (error) {
      this.readError = error;
    }
  }
  get(pluginId: string, profile: string): State | undefined {
    const state = this.states.get(JSON.stringify([pluginId, profile]));
    return state ? structuredClone(state) : undefined;
  }
  remember(state: State): void {
    const key = JSON.stringify([state.pluginId, state.profile]);
    if (!this.states.has(key) && this.states.size >= 512)
      this.states.delete(this.states.keys().next().value!);
    this.states.set(key, structuredClone(state));
  }
  flush(): void {
    if (this.readError) return;
    atomicWrite(this.file, JSON.stringify(stateSchema.parse([...this.states.values()])));
  }
}
