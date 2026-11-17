import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { listLayerInstances, updateLayerInstance } from "../host/layer-instances.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";

export function createLayerCommands(
  ctx: Pick<
    RuntimeContext,
    | "widgetHost"
    | "desktopLayer"
    | "utoolsDesktop"
    | "windowDesktop"
    | "screenshotLayer"
    | "notesMigrationError"
    | "isAdminView"
    | "toggleDesktopOverlay"
    | "pluginWindowLayouts"
    | "pluginWindowCoordinator"
    | "pluginWindowAdapters"
    | "pluginHost"
  >,
) {
  const run = async ({ command, args, layout }: CommandInvocation) => {
    if (!ctx.isAdminView(layout) || !ctx.widgetHost || !ctx.desktopLayer)
      throw new AppError("permissionDenied", "Desktop cards are managed by host settings");
    switch (command) {
      case "desktop_overlay_toggle":
        return ctx.toggleDesktopOverlay();
      case "layer_listTemplates": {
        return { ...listLayerInstances(ctx), notesMigrationError: ctx.notesMigrationError };
      }
      case "layer_create":
        if (ctx.pluginWindowCoordinator) {
          const placement = await ctx.pluginWindowCoordinator.open({
            pluginId: String(args.pluginId),
            windowId: String(args.widgetDefinitionId),
            action: "create",
            environment: "desktop",
          });
          return { widgetInstanceId: placement.id };
        }
        return {
          widgetInstanceId: await ctx.widgetHost.create(
            String(args.pluginId),
            String(args.widgetDefinitionId),
          ),
        };
      case "layer_remove": {
        const id = String(args.widgetInstanceId);
        if (ctx.pluginWindowLayouts?.load().pendingCreates.some((value) => value.id === id)) {
          ctx.pluginWindowLayouts.commit((draft) => {
            draft.pendingCreates = draft.pendingCreates.filter((value) => value.id !== id);
          });
          return;
        }
        if (ctx.pluginWindowLayouts?.load().placements.some((value) => value.id === id))
          return ctx.pluginWindowCoordinator?.close(id);
        if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.remove(id);
        if (ctx.windowDesktop?.has(id)) return ctx.windowDesktop.remove(id);
        return ctx.screenshotLayer?.has(id)
          ? ctx.screenshotLayer.close(id)
          : ctx.widgetHost.remove(id);
      }
      case "layer_retry": {
        const id = String(args.widgetInstanceId);
        if (ctx.pluginWindowLayouts?.load().pendingCreates.some((value) => value.id === id))
          return ctx.pluginWindowCoordinator?.resumeCreates(id);
        const state = ctx.pluginWindowLayouts?.load();
        const placement = state?.placements.find((value) => value.id === id);
        const instance = state?.instances.find((value) => value.id === placement?.instanceId);
        if (placement && instance)
          return ctx.pluginWindowCoordinator?.open({
            pluginId: instance.pluginId,
            windowId: instance.binding.windowId,
            instanceId: instance.id,
            binding: instance.binding,
            environment: placement.environment,
            action: "restore",
          });
        if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.retry(id);
        if (ctx.windowDesktop?.has(id)) return ctx.windowDesktop.retry(id);
        return ctx.screenshotLayer?.has(id)
          ? ctx.screenshotLayer.retry(id)
          : ctx.widgetHost.retry(id);
      }
      case "layer_locate": {
        const state = ctx.pluginWindowLayouts?.load();
        const placement = state?.placements.find((value) => value.id === args.widgetInstanceId);
        const instance = state?.instances.find((value) => value.id === placement?.instanceId);
        if (!placement || !instance || !ctx.pluginWindowCoordinator)
          throw new AppError("window.restoreMissing", "窗口展示已不存在");
        if (placement.environment === "desktop") await ctx.desktopLayer.closeOverlay(false);
        await ctx.pluginWindowCoordinator.open({
          pluginId: instance.pluginId,
          windowId: instance.binding.windowId,
          instanceId: instance.id,
          binding: instance.binding,
          environment: placement.environment,
          action: "restore",
        });
        if (placement.environment === "card-desktop") {
          if (!ctx.desktopLayer.overlayActive) await ctx.toggleDesktopOverlay();
          await ctx.desktopLayer.locateWindow(instance.id);
        }
        return;
      }
      case "layer_update": {
        return updateLayerInstance(
          ctx,
          String(args.widgetInstanceId),
          args.patch as Parameters<typeof ctx.widgetHost.update>[1],
        );
      }
      case "layer_edit":
        return {
          editSession: await ctx.desktopLayer.beginEdit(args.displayId as string | undefined),
        };
    }
  };
  return {
    desktop_overlay_toggle: run,
    layer_listTemplates: run,
    layer_create: run,
    layer_remove: run,
    layer_retry: run,
    layer_locate: run,
    layer_update: run,
    layer_edit: run,
  } satisfies Record<string, CommandHandler>;
}
