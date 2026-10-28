import type { PluginContext } from "@spark233/sdk";
import fs from "node:fs";
import { confined } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";

/** Ordinary launcher drag/drop context and resource revocation. */
export function createContextRuntime(
  ctx: Pick<
    RuntimeContext,
    | "launcherCallers"
    | "launcherContext"
    | "launcherContextRevision"
    | "pluginFiles"
    | "pluginImages"
    | "diagnostics"
    | "resourceRevocations"
    | "configDir"
    | "launcher"
    | "emit"
  >,
) {
  function contextForCaller(
    caller?: string,
  ): { context: PluginContext; label: string } | undefined {
    if (caller && ![...ctx.launcherCallers.values()].includes(caller)) return;
    return ctx.launcherContext;
  }
  function contextRevisionForCaller(caller?: string): number {
    if (caller && ![...ctx.launcherCallers.values()].includes(caller)) return 0;
    return ctx.launcherContextRevision;
  }
  function notifyResourceRevocations(ids: readonly string[]): void {
    if (!ids.length) return;
    for (const listener of ctx.resourceRevocations)
      try {
        listener(ids);
      } catch {
        console.warn("context-resource-revocation-failed");
      }
  }

  function clearLauncherContext(): void {
    const previous = ctx.launcherContext;
    const revoked =
      previous?.context.kind === "image"
        ? [previous.context.resource.id]
        : previous?.context.kind === "files"
          ? previous.context.resources.map((resource) => resource.id)
          : [];
    const image =
      previous?.context.kind === "image"
        ? ctx.pluginImages.get(previous.context.resource.id)
        : undefined;
    ctx.launcherContextRevision++;
    ctx.launcherContext = undefined;
    if (image?.owner.pluginId === "spark233.host") ctx.pluginImages.delete(image.resource.id);
    if (previous?.context.kind === "files")
      for (const resource of previous.context.resources) ctx.pluginFiles.delete(resource.id);
    notifyResourceRevocations(revoked);
    if (image?.owner.pluginId === "spark233.host")
      try {
        fs.rmSync(confined(ctx.configDir, "launcher-resources", `${image.sessionId}.png`), {
          force: true,
        });
      } catch {
        ctx.diagnostics?.record({
          kind: "host",
          code: "failed",
          level: "warn",
          errorCode: "diskUnavailable",
        });
      }
    if (ctx.launcher) {
      ctx.launcher.pluginsChanged();
      ctx.emit("launcher-status-changed");
    }
  }
  return {
    contextForCaller,
    contextRevisionForCaller,
    notifyResourceRevocations,
    clearLauncherContext,
  };
}
