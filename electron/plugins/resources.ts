import { randomUUID } from "node:crypto";
import type { PluginOwner, StopReason } from "../../packages/sdk/src/index.js";

export type StopDecision = { ok: true } | { ok: false; reason: string };
export type ResourceKind = "task" | "event" | "shortcut" | "window" | "process";
export interface OwnedResource {
  prepareStop?: (reason: StopReason) => StopDecision | Promise<StopDecision>;
  dispose: () => void | Promise<void>;
}
export interface ReleaseResult {
  ok: boolean;
  errors: string[];
}
export type ResourceScopeState = "active" | "preparing" | "prepared" | "releasing" | "released";

export function samePluginOwner(left: PluginOwner, right: PluginOwner): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.version === right.version &&
    left.instanceId === right.instanceId
  );
}

// Existing window/shortcut owners are business-specific. This scope only composes
// their cleanup callbacks; Node and Electron do not provide a plugin ownership scope.
export class PluginResourceScope {
  readonly owner: Readonly<PluginOwner>;
  private currentState: ResourceScopeState = "active";
  private resources = new Map<
    string,
    { kind: ResourceKind; resource: OwnedResource; releasing?: Promise<void> }
  >();
  private preparation?: Promise<StopDecision>;
  private releasing?: Promise<ReleaseResult>;

  constructor(owner: PluginOwner) {
    if (!owner.pluginId || !owner.version || !owner.instanceId)
      throw new Error("Plugin resource owner must include id, version and instance");
    this.owner = Object.freeze({ ...owner });
  }

  get state(): ResourceScopeState {
    return this.currentState;
  }
  get size(): number {
    return this.resources.size;
  }

  accepts(owner: PluginOwner): boolean {
    return (
      this.currentState !== "releasing" &&
      this.currentState !== "released" &&
      samePluginOwner(this.owner, owner)
    );
  }

  own(kind: ResourceKind, resource: OwnedResource): () => Promise<void> {
    if (this.currentState !== "active")
      throw new Error("Plugin scope is not accepting new resources");
    const id = randomUUID();
    const entry = { kind, resource } as {
      kind: ResourceKind;
      resource: OwnedResource;
      releasing?: Promise<void>;
    };
    this.resources.set(id, entry);
    return () => this.releaseResource(id, entry);
  }

  private releaseResource(
    id: string,
    entry: { resource: OwnedResource; releasing?: Promise<void> },
  ): Promise<void> {
    if (!this.resources.has(id)) return Promise.resolve();
    if (entry.releasing) return entry.releasing;
    const operation = Promise.resolve()
      .then(() => entry.resource.dispose())
      .then(() => {
        this.resources.delete(id);
      })
      .finally(() => {
        entry.releasing = undefined;
      });
    entry.releasing = operation;
    return operation;
  }

  prepareStop(reason: StopReason): Promise<StopDecision> {
    if (this.preparation) return this.preparation;
    if (this.currentState === "prepared" || this.currentState === "released")
      return Promise.resolve({ ok: true });
    if (this.currentState !== "active")
      return Promise.resolve({ ok: false, reason: "Resources are already being released" });
    this.currentState = "preparing";
    const operation = (async (): Promise<StopDecision> => {
      try {
        for (const [id, { resource }] of this.resources) {
          if (!this.resources.has(id) || !resource.prepareStop) continue;
          const decision = await resource.prepareStop(reason);
          if (!decision.ok) {
            this.currentState = "active";
            return decision;
          }
        }
        this.currentState = "prepared";
        return { ok: true };
      } catch (error) {
        this.currentState = "active";
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    })().finally(() => {
      this.preparation = undefined;
    });
    this.preparation = operation;
    return operation;
  }

  cancelStop(): void {
    if (this.currentState === "prepared") this.currentState = "active";
    else if (this.currentState !== "active")
      throw new Error("Cannot cancel a stop while preparation or release is in flight");
  }

  release(): Promise<ReleaseResult> {
    if (this.releasing) return this.releasing;
    if (this.currentState === "released") return Promise.resolve({ ok: true, errors: [] });
    if (this.currentState !== "prepared" && this.currentState !== "releasing")
      return Promise.resolve({
        ok: false,
        errors: ["Resources require successful prepareStop before release"],
      });
    // Fence results before any cancellation callback can produce a final event.
    this.currentState = "releasing";
    const operation = (async () => {
      const errors: string[] = [];
      for (const kind of ["task", "event", "shortcut", "window", "process"] as const) {
        for (const [id, entry] of this.resources) {
          if (entry.kind !== kind) continue;
          try {
            await this.releaseResource(id, entry);
          } catch (error) {
            errors.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (this.resources.size === 0) this.currentState = "released";
      return { ok: errors.length === 0, errors };
    })().finally(() => {
      this.releasing = undefined;
    });
    this.releasing = operation;
    return operation;
  }

  async stop(reason: StopReason): Promise<ReleaseResult> {
    if (this.currentState === "releasing" || this.currentState === "released")
      return this.release();
    const decision = await this.prepareStop(reason);
    return decision.ok ? this.release() : { ok: false, errors: [decision.reason] };
  }
}
