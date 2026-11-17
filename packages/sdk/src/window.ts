import { z } from "zod";
import type { JsonValue, PluginWindow } from "./index.js";
import { assertWidgetJson } from "./widget.js";

export type WindowEnvironment = "desktop" | "card-desktop";
export const windowBindingSchema = z.strictObject({
  windowId: z.string().min(1).max(80),
  contentId: z.string().min(1).max(200).optional(),
  parameterVersion: z.number().int().min(1).max(1000),
  parameters: z
    .custom<JsonValue>((value) => {
      try {
        assertWidgetJson(value, 256 * 1024, 32, 16384, 32768);
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
});
export type WindowBinding = z.infer<typeof windowBindingSchema>;
export const windowCreateResultSchema = z.strictObject({
  kind: z.literal("window-binding"),
  binding: windowBindingSchema,
});
export type WindowCreateResult = z.infer<typeof windowCreateResultSchema>;
export interface WindowCapabilities {
  resizable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  topmost: boolean;
}
/** Environment restrictions apply to native controls, menus and plugin APIs alike. */
export function effectiveWindowCapabilities(
  window: Pick<PluginWindow, "resizable" | "minimizable" | "maximizable">,
  environment: WindowEnvironment,
): WindowCapabilities {
  const desktop = environment === "desktop";
  return {
    resizable: window.resizable !== false,
    minimizable: desktop && window.minimizable !== false,
    maximizable: desktop && window.maximizable !== false,
    topmost: desktop,
  };
}
