import { z } from "zod";
import type { MenuItemConstructorOptions } from "electron";
import type { PluginManifest, PluginTrayItem, PluginTrayItemState } from "@spark233/sdk";
import type { AppConfig } from "../../src/features/settings/types.js";
import type { PluginResourceScope } from "../plugins/resources.js";

const stateSchema = z.strictObject({
  id: z.string().min(1).max(80),
  checked: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** Runtime state belongs to the resource scope, never to the next plugin instance. */
export class PluginTrayStateStore {
  private readonly states = new Map<
    string,
    { scope: PluginResourceScope; items: Map<string, PluginTrayItemState> }
  >();
  constructor(private readonly changed: () => void) {}

  attach(scope: PluginResourceScope, manifest: PluginManifest): (payload: unknown) => void {
    const record = { scope, items: new Map<string, PluginTrayItemState>() };
    this.states.set(scope.owner.pluginId, record);
    scope.own("event", {
      dispose: () => {
        if (this.states.get(scope.owner.pluginId) === record) {
          this.states.delete(scope.owner.pluginId);
          this.changed();
        }
      },
    });
    return (payload) => {
      if (scope.state !== "active" || this.states.get(scope.owner.pluginId) !== record)
        throw new Error("Plugin tray instance has expired");
      const { id, ...state } = stateSchema.parse(payload);
      const item = manifest.tray?.find((entry) => entry.id === id);
      if (!item || (state.checked !== undefined && item.type !== "checkbox"))
        throw new Error("Tray state must name this plugin's declared item");
      record.items.set(id, { ...record.items.get(id), ...state });
      this.changed();
    };
  }

  get(pluginId: string, id: string): PluginTrayItemState {
    const record = this.states.get(pluginId);
    return record?.scope.state === "active" ? (record.items.get(id) ?? {}) : {};
  }
}

export interface TrayPlugin {
  pluginId: string;
  version: string;
  displayName: string;
  enabled: boolean;
  commands: Array<{ id: string; title: string }>;
  tray?: PluginTrayItem[];
}

/** Electron owns native menu rendering. This adapter resolves only declared commands. */
export function buildPluginTrayMenu(options: {
  plugins: () => TrayPlugin[];
  preferences: () => AppConfig["trayMenu"];
  available: (pluginId: string, commandId: string) => boolean;
  state: (pluginId: string, id: string) => PluginTrayItemState;
  blocked: () => boolean;
  activate: (pluginId: string, commandId: string) => Promise<unknown>;
  onError: (error: unknown) => void;
}): MenuItemConstructorOptions[] {
  const preferences = options.preferences();
  const order = preferences?.order ?? [];
  const rank = (plugin: TrayPlugin) => {
    const index = order.indexOf(plugin.pluginId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return options
    .plugins()
    .filter((plugin) => plugin.enabled)
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((plugin) => {
      const submenu: MenuItemConstructorOptions[] = [];
      let previousGroup: string | undefined;
      for (const item of [...(plugin.tray ?? [])].sort((a, b) => {
        const aIndex = order.indexOf(plugin.pluginId + ":" + a.id);
        const bIndex = order.indexOf(plugin.pluginId + ":" + b.id);
        return (
          (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
            (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex) || (a.order ?? 0) - (b.order ?? 0)
        );
      })) {
        const key = plugin.pluginId + ":" + item.id;
        const command = plugin.commands.find((entry) => entry.id === item.commandId);
        if (
          preferences?.hidden.includes(key) ||
          !command ||
          !options.available(plugin.pluginId, item.commandId)
        )
          continue;
        if (submenu.length && previousGroup !== item.group) submenu.push({ type: "separator" });
        previousGroup = item.group;
        const state = options.state(plugin.pluginId, item.id);
        submenu.push({
          label: (item.title ?? command.title).replaceAll("&", "&&"),
          type: item.type ?? "normal",
          ...(item.type === "checkbox" ? { checked: state.checked ?? false } : {}),
          enabled: !options.blocked() && state.enabled !== false,
          click: (clicked) => {
            // Electron toggles a checkbox before dispatch. Restore it until the
            // plugin publishes its actual state, including on failed activation.
            if (item.type === "checkbox")
              clicked.checked = options.state(plugin.pluginId, item.id).checked ?? false;
            const current = options.plugins().find((entry) => entry.pluginId === plugin.pluginId);
            if (
              options.blocked() ||
              !current?.enabled ||
              current.version !== plugin.version ||
              !current.tray?.some(
                (entry) => entry.id === item.id && entry.commandId === item.commandId,
              ) ||
              options.preferences()?.hidden.includes(key) ||
              !options.available(plugin.pluginId, item.commandId) ||
              options.state(plugin.pluginId, item.id).enabled === false
            )
              return;
            void Promise.resolve()
              .then(() => options.activate(plugin.pluginId, item.commandId))
              .catch(options.onError);
          },
        });
      }
      return submenu.length ? [{ label: plugin.displayName.replaceAll("&", "&&"), submenu }] : [];
    });
}
