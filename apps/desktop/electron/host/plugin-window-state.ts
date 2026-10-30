import fs from "node:fs";
import { z } from "zod";
import { atomicWrite, readJson } from "../persistence.js";

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
