import type { ShortcutCheckResult, SettingsTarget } from "./types";
export type { ShortcutCheckResult, SettingsTarget, SettingsPage } from "./types";
import { invoke } from "../../platform/desktop";
import { open } from "../../platform/desktop";
import type { AppConfig, AppConfigPatch, ViewMode } from "./types";
import i18n from "../../locales";

export function getConfig(): Promise<AppConfig> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<AppConfig>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(i18n.t("shell.configTimeout"))), 5000);
    void invoke("config_get").then(resolve, reject);
  }).finally(() => clearTimeout(timer));
}

export function patchConfig(
  patch: AppConfigPatch,
  options?: {
    expectedCommandShortcuts?: Record<string, string>;
    expectedShortcuts?: Pick<
      AppConfig,
      "globalShortcut" | "toggleVisibilityShortcut" | "desktopOverlayShortcut"
    >;
  },
): Promise<AppConfig> {
  return invoke("config_patch", { patch, ...options });
}

export function checkGlobalShortcut(shortcut: string): Promise<ShortcutCheckResult> {
  return invoke("global_shortcut_check", { shortcut });
}

export async function chooseDataDirectory(): Promise<string | null> {
  const path = await open({
    directory: true,
    multiple: false,
  });

  return typeof path === "string" ? path : null;
}

export function migrateDataDir(newDataDir: string): Promise<AppConfig> {
  return invoke("config_migrate_data_dir", { newDataDir });
}

export async function chooseBackgroundImage(): Promise<string | null> {
  const path = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });

  return typeof path === "string" ? path : null;
}

export function normalizeViewMode(value: string): ViewMode {
  if (value === "edit" || value === "split") {
    return value;
  }

  return "edit";
}

export function openSettingsWindow(target: SettingsTarget = {}): Promise<void> {
  return invoke("settings_open", target);
}
