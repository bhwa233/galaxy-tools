import type { PluginOwner } from "@spark233/sdk";
import type { PluginWindowActivation } from "../../shared/plugin-windows.js";
import { samePluginOwner } from "../plugins/resources.js";

/** A window's handoff is independent of launcher query tokens. A replaced plugin
 * instance cannot consume its successor's activation, even when a window ID is reused. */
export class PluginWindowActivations {
  private revision = 0;
  private pending = new Map<number, PluginWindowActivation>();
  enqueue(windowId: number, owner: PluginOwner, payload: unknown): PluginWindowActivation {
    const activation = {
      revision: ++this.revision,
      owner: { ...owner },
      payload: structuredClone(payload),
    };
    this.pending.set(windowId, activation);
    return activation;
  }
  take(windowId: number, owner: PluginOwner): PluginWindowActivation | undefined {
    const activation = this.pending.get(windowId);
    if (!activation || !samePluginOwner(activation.owner, owner)) return;
    this.pending.delete(windowId);
    return activation;
  }
  revoke(windowId: number): void {
    this.pending.delete(windowId);
  }
}
