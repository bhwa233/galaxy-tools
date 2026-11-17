import type { LayerManagementState } from "../../shared/layer-contract.js";
import type { RuntimeContext } from "../runtime.js";
import { pluginWindowCatalog } from "./plugin-window-catalog.js";

type LayerHosts = Pick<
  RuntimeContext,
  | "widgetHost"
  | "utoolsDesktop"
  | "windowDesktop"
  | "screenshotLayer"
  | "pluginWindowLayouts"
  | "pluginWindowCoordinator"
  | "pluginWindowAdapters"
  | "pluginHost"
>;
export type LayerInstancePatch = Parameters<NonNullable<RuntimeContext["widgetHost"]>["update"]>[1];

/** One listing of every desktop card owner, shared by settings and the tray. */
export function listLayerInstances(ctx: LayerHosts): LayerManagementState {
  const state = ctx.widgetHost!.list();
  const layout = ctx.pluginWindowLayouts?.load();
  const definitions =
    ctx.pluginHost?.manager.list().flatMap((plugin) => {
      try {
        return pluginWindowCatalog(
          ctx.pluginHost!.manager.describe(plugin.pluginId, true).spark233,
        );
      } catch {
        return [];
      }
    }) ?? [];
  return {
    ...state,
    templates: definitions
      .filter((definition) => definition.purpose === "business")
      .map((definition) => ({
        pluginId: definition.pluginId,
        widgetDefinitionId: definition.windowId,
        title: definition.title,
        kind: definition.content.kind === "page" ? "window" : definition.content.kind,
        quota: {
          active:
            layout?.instances.filter(
              (instance) =>
                instance.pluginId === definition.pluginId &&
                instance.binding.windowId === definition.windowId,
            ).length ?? 0,
          limit: 4096,
        },
      })),
    instances: [
      ...(layout?.pendingCreates.map((intent) => ({
        widgetInstanceId: intent.id,
        pluginId: intent.pluginId,
        widgetDefinitionId: intent.windowId,
        title:
          definitions.find(
            (value) => value.pluginId === intent.pluginId && value.windowId === intent.windowId,
          )?.title ?? intent.windowId,
        pendingCreation: true,
        environment: intent.environment,
        displayId: "workspace",
        visible: false,
        canLocate: false,
        canRetry: !!intent.binding || intent.pluginId === "spark233.notes",
        bounds: intent.bounds,
        status: "fault" as const,
        reason: intent.binding
          ? "内容已创建，等待恢复展示"
          : "创建结果尚未确认，保留原意图以避免重复新建",
      })) ?? []),
      ...state.instances.filter(
        (value) => !layout?.instances.some((instance) => instance.id === value.widgetInstanceId),
      ),
      ...(ctx.screenshotLayer?.list() ?? []),
      ...(ctx.utoolsDesktop?.list() ?? []).filter(
        (value) => !layout?.instances.some((instance) => instance.id === value.widgetInstanceId),
      ),
      ...(ctx.windowDesktop?.list() ?? []),
      ...(layout?.placements.map((placement) => {
        const instance = layout.instances.find((value) => value.id === placement.instanceId)!;
        const definition = definitions.find(
          (value) =>
            value.pluginId === instance.pluginId && value.windowId === instance.binding.windowId,
        );
        const plugin = ctx.pluginHost?.manager
          .list()
          .find((value) => value.pluginId === instance.pluginId);
        const widget = [...state.instances, ...(ctx.utoolsDesktop?.list() ?? [])].find(
          (value) => value.widgetInstanceId === instance.id,
        );
        const failure =
          ctx.pluginWindowAdapters?.failure(instance.id) ??
          (widget?.status === "fault" ? widget.reason : undefined);
        const available = !!plugin?.enabled && !plugin.lastError && !!definition;
        return {
          widgetInstanceId: placement.id,
          pluginId: instance.pluginId,
          widgetDefinitionId: instance.binding.windowId,
          environment: placement.environment,
          title: definition?.title ?? instance.binding.windowId,
          displayId: placement.displayId ?? "workspace",
          visible: placement.visible,
          bounds: placement.bounds,
          group: placement.topmost ? ("top" as const) : ("normal" as const),
          inputMode: "interactive" as const,
          canRetry: available && (!!failure || widget?.status === "fault"),
          canLocate: available,
          reason: !plugin?.enabled
            ? "插件已停用或不可用"
            : (plugin.lastError ??
              (!definition ? "窗口声明已不存在，保留原内容与布局" : (failure ?? widget?.reason))),
          status:
            !plugin?.enabled || !definition
              ? ("orphan" as const)
              : plugin.lastError || failure || widget?.status === "fault"
                ? ("fault" as const)
                : widget?.status === "suspended"
                  ? ("suspended" as const)
                  : placement.visible
                    ? ("active" as const)
                    : ("hidden" as const),
        };
      }) ?? []),
    ],
  };
}

/** Route a card patch to whichever host owns the instance id. */
export async function updateLayerInstance(
  ctx: LayerHosts,
  id: string,
  patch: LayerInstancePatch,
): Promise<unknown> {
  const placement = ctx.pluginWindowLayouts?.load().placements.find((value) => value.id === id);
  if (placement) {
    if (placement.environment === "card-desktop" && (patch.group || patch.inputMode))
      throw new Error("Card desktop panels do not support topmost or click-through");
    ctx.pluginWindowLayouts!.commit((state) => {
      const target = state.placements.find((value) => value.id === id)!;
      if (patch.visible !== undefined) target.visible = patch.visible;
      if (patch.bounds) target.bounds = patch.bounds;
      if (patch.group && placement.environment === "desktop")
        target.topmost = patch.group === "top";
    });
    await ctx.pluginWindowCoordinator?.refresh(id);
    return ctx.widgetHost?.sync();
  }
  if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.update(id, patch);
  if (ctx.windowDesktop?.has(id)) return ctx.windowDesktop.update(id, patch);
  return ctx.screenshotLayer?.has(id)
    ? ctx.screenshotLayer.update(id, patch)
    : ctx.widgetHost!.update(id, patch);
}
