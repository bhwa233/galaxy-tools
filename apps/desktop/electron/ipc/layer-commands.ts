import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";

export function createLayerCommands(
  ctx: Pick<
    RuntimeContext,
    | "widgetHost"
    | "desktopLayer"
    | "utoolsDesktop"
    | "screenshotLayer"
    | "notesMigrationError"
    | "isAdminView"
    | "toggleDesktopOverlay"
  >,
) {
  const run = async ({ command, args, layout }: CommandInvocation) => {
    if (!ctx.isAdminView(layout) || !ctx.widgetHost || !ctx.desktopLayer)
      throw new AppError("permissionDenied", "Desktop cards are managed by host settings");
    switch (command) {
      case "desktop_overlay_toggle":
        return ctx.toggleDesktopOverlay();
      case "layer_listTemplates": {
        const state = ctx.widgetHost.list();
        return {
          ...state,
          instances: [
            ...state.instances,
            ...(ctx.screenshotLayer?.list() ?? []),
            ...(ctx.utoolsDesktop?.list() ?? []),
          ],
          notesMigrationError: ctx.notesMigrationError,
        };
      }
      case "layer_create":
        return {
          widgetInstanceId: await ctx.widgetHost.create(
            String(args.pluginId),
            String(args.widgetDefinitionId),
          ),
        };
      case "layer_remove": {
        const id = String(args.widgetInstanceId);
        if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.remove(id);
        return ctx.screenshotLayer?.has(id)
          ? ctx.screenshotLayer.close(id)
          : ctx.widgetHost.remove(id);
      }
      case "layer_retry": {
        const id = String(args.widgetInstanceId);
        if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.retry(id);
        return ctx.screenshotLayer?.has(id)
          ? ctx.screenshotLayer.retry(id)
          : ctx.widgetHost.retry(id);
      }
      case "layer_update": {
        const id = String(args.widgetInstanceId);
        const patch = args.patch as Parameters<typeof ctx.widgetHost.update>[1];
        if (ctx.utoolsDesktop?.has(id)) return ctx.utoolsDesktop.update(id, patch);
        return ctx.screenshotLayer?.has(id)
          ? ctx.screenshotLayer.update(id, patch)
          : ctx.widgetHost.update(id, patch);
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
    layer_update: run,
    layer_edit: run,
  } satisfies Record<string, CommandHandler>;
}
