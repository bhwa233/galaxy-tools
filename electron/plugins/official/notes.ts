import type { JsonValue, PluginActivation, StopReason } from "../../../packages/sdk/src/index.js";
import { AppError } from "../../persistence.js";
import type { PluginBackendController } from "../backend.js";
import type { ManagedPluginRuntime } from "../manager.js";
import { PluginResourceScope, type StopDecision } from "../resources.js";

export interface NotesRuntimeOptions {
  scope: PluginResourceScope;
  backend: Pick<PluginBackendController, "activate"> &
    Partial<Pick<PluginBackendController, "prepareStop">>;
  openManager: () => void | Promise<void>;
  newNote: (activation: PluginActivation) => void | Promise<void>;
  openNote: (id: string, activation: PluginActivation) => void | Promise<void>;
  showOnDesktop: (id: string) => void | Promise<void>;
  search?: (query: string) => JsonValue | undefined | Promise<JsonValue | undefined>;
  prepare: (reason: StopReason) => StopDecision | Promise<StopDecision>;
  stop: () => void | Promise<void>;
  start: () => void | Promise<void>;
}

/** Keep window effects behind host callbacks; data commands execute in the utility. */
export async function createNotesRuntime(
  options: NotesRuntimeOptions,
): Promise<ManagedPluginRuntime> {
  const { scope } = options;
  const active = new Set<Promise<JsonValue | undefined>>();
  scope.own("event", {
    prepareStop: async (reason) => {
      // Finish already dispatched host writes/open actions before asking their
      // windows to save; do not cancel them while a save refusal is still possible.
      while (active.size) await Promise.allSettled(active);
      const decision = await options.prepare(reason);
      while (active.size) await Promise.allSettled(active);
      if (!decision.ok) return decision;
      // Final renderer saves use the owner's maintenance route after the
      // backend's first prepare. Confirm durable preparation again before release.
      return (await options.backend.prepareStop?.(reason)) ?? decision;
    },
    dispose: options.stop,
  });
  // Construction reattaches resources exactly once for each new running instance.
  // The manager's subsequent on-startup activate({}) must not create a note UI.
  await options.start();

  async function activate(activation: PluginActivation): Promise<JsonValue | undefined> {
    if (scope.state !== "active") throw new AppError("pluginDisabled", "便签插件当前不可用");
    if (!activation.commandId) return;
    const response = await options.backend.activate(activation);
    if (!scope.accepts(scope.owner)) throw new AppError("pluginDisabled", "便签插件运行实例已失效");
    if (activation.commandId === "data") return response;
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      typeof response.action !== "string"
    )
      throw new AppError("invalidPluginResponse", "便签后台没有返回有效操作");
    const parameters =
      activation.parameters &&
      typeof activation.parameters === "object" &&
      !Array.isArray(activation.parameters)
        ? activation.parameters
        : {};
    switch (response.action) {
      case "open":
        await options.openManager();
        return;
      case "new":
        await options.newNote(activation);
        return;
      case "open-note":
      case "desktop-note": {
        const id = parameters.id;
        if (typeof id !== "string" || !id.trim())
          throw new AppError("invalidPayload", "打开便签需要有效身份");
        if (response.action === "desktop-note") await options.showOnDesktop(id);
        else await options.openNote(id, activation);
        return;
      }
      case "search": {
        const query =
          typeof parameters.query === "string"
            ? parameters.query
            : activation.context?.kind === "text"
              ? activation.context.text
              : "";
        if (options.search) return options.search(query);
        await options.openManager();
        return;
      }
      default:
        throw new AppError("unknownPluginCommand", "便签后台返回了未知操作");
    }
  }

  return {
    activate(activation) {
      const operation = activate(activation);
      active.add(operation);
      void operation.finally(() => active.delete(operation)).catch(() => {});
      return operation;
    },
  };
}
