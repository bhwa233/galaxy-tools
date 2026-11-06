import type { LayerManagementState } from "../../shared/layer-contract.js";
import type { RuntimeContext } from "../runtime.js";

type LayerHosts = Pick<RuntimeContext, "widgetHost" | "utoolsDesktop" | "screenshotLayer">;
export type LayerInstancePatch = Parameters<NonNullable<RuntimeContext["widgetHost"]>["update"]>[1];

/** One listing of every desktop card owner, shared by settings and the tray. */
export function listLayerInstances(ctx: LayerHosts): LayerManagementState {
  const state = ctx.widgetHost!.list();
  return {
    ...state,
    instances: [
      ...state.instances,
      ...(ctx.screenshotLayer?.list() ?? []),
      ...(ctx.utoolsDesktop?.list() ?? []),
    ],
  };
}

/** Route a card patch to whichever host owns the instance id. */
export async function updateLayerInstance(
  ctx: LayerHosts,
  id: string,
  patch: LayerInstancePatch,
): Promise<unknown> {
  if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.update(id, patch);
  return ctx.screenshotLayer?.has(id)
    ? ctx.screenshotLayer.update(id, patch)
    : ctx.widgetHost!.update(id, patch);
}
