import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  clipboardSettingsFields,
  noteSettingsFields,
  searchSettingsFields,
  translationSettingsFields,
} from "../../src/features/plugins/settingsFields.js";
import type { AppConfig } from "../../src/features/settings/types.js";
import { atomicWrite } from "../persistence.js";
import {
  ClipboardHistory,
  settingsSchema as clipboardSettingsSchema,
} from "../plugins/official/clipboard-history.js";
import {
  settingsSchema as searchSettingsSchema,
  validateSettings as validateSearchSettings,
} from "../plugins/official/search-settings.js";
import { PluginSettingsService, type PluginSettingsAdapter } from "../plugins/settings.js";
import { writeTranslationSettings } from "../plugins/translation-settings.js";
import type { RuntimeContext } from "../runtime.js";
export function createPluginSettings(
  ctx: Pick<
    RuntimeContext,
    | "pluginHost"
    | "hostConfig"
    | "settingsCaller"
    | "handle"
    | "translationSettings"
    | "translationSettingsFile"
    | "launcher"
    | "emit"
    | "clipboardRuntime"
  >,
): PluginSettingsService {
  return new PluginSettingsService(
    (id): PluginSettingsAdapter => {
      if (!ctx.pluginHost) throw new Error("Plugin host is not ready");
      const manager = ctx.pluginHost.manager;
      manager.describe(id);
      const directory = manager.dataDirectory(id);
      if (id === "spark233.notes")
        return {
          fields: noteSettingsFields,
          read: () =>
            Object.fromEntries(
              noteSettingsFields
                .filter((field) => ctx.hostConfig.value[field.key as keyof AppConfig] !== undefined)
                .map((field) => [field.key, ctx.hostConfig.value[field.key as keyof AppConfig]]),
            ),
          save: async (values) => {
            if (!ctx.settingsCaller || ctx.settingsCaller.isDestroyed())
              throw new Error("Settings document closed");
            await ctx.handle(ctx.settingsCaller, "config_patch", { patch: values });
          },
        };
      if (id === "spark233.translation")
        return {
          fields: translationSettingsFields,
          read: ctx.translationSettings,
          save: (values) =>
            writeTranslationSettings(ctx.translationSettingsFile(), values, (key) => {
              if (!safeStorage.isEncryptionAvailable())
                throw new Error("系统密钥加密暂不可用，未保存密钥");
              return safeStorage.encryptString(key);
            }),
        };
      if (id === "spark233.search") {
        const file = path.join(directory, "search-scope.json");
        return {
          fields: searchSettingsFields,
          read: () =>
            fs.existsSync(file)
              ? validateSearchSettings(JSON.parse(fs.readFileSync(file, "utf8")))
              : searchSettingsSchema.parse({ excludedRoots: [] }),
          save: async (values) => {
            const next = validateSearchSettings(values);
            const active =
              manager.list().find((plugin) => plugin.pluginId === id)?.status === "active";
            if (active)
              await manager.activate(id, {
                commandId: "settings",
                parameters: { action: "save", ...next },
              });
            else atomicWrite(file, JSON.stringify(next));
            ctx.launcher.clear();
            ctx.emit("search-scope-changed");
          },
        };
      }
      if (id === "spark233.clipboard") {
        const withHistory = <T>(action: (history: ClipboardHistory) => T): T => {
          const history = new ClipboardHistory(directory);
          try {
            return action(history);
          } finally {
            history.close();
          }
        };
        return {
          fields: clipboardSettingsFields,
          read: () => withHistory((history) => ({ ...history.settings() })),
          save: async (values) => {
            const next = clipboardSettingsSchema.parse(values);
            if (ctx.clipboardRuntime)
              await ctx.clipboardRuntime.request({ action: "settings", patch: next });
            else withHistory((history) => history.saveSettings(next));
            ctx.emit("clipboard-changed");
          },
        };
      }
      return { fields: [], read: () => ({}), save: () => {} };
    },
    (id) => {
      const record = ctx.pluginHost?.manager.list().find((plugin) => plugin.pluginId === id);
      if (!record) throw new Error("Plugin is not installed");
      return JSON.stringify([record.packageName, record.version, record.integrity]);
    },
  );
}
