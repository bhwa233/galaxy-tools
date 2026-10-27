import { invoke } from "../../platform/desktop";
import { open } from "../../platform/desktop";
import type { AppConfig, AppConfigPatch, ViewMode } from "./types";

export interface ShortcutCheckResult {
  available: boolean;
  conflictType: "none" | "current" | "invalid" | "system" | "registered" | "unknown";
  message: string;
}

export function getConfig(): Promise<AppConfig> {
  return invoke("config_get");
}

export function patchConfig(
  patch: AppConfigPatch,
  options?: { expectedCommandShortcuts: Record<string, string> },
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

export type SettingsPage = "general" | "entries" | "plugins" | "backup" | "diagnostics";
export interface SettingsTarget {
  page?: SettingsPage;
  pluginId?: string;
  tab?: "config" | "functions" | "matching" | "info";
}
export function openSettingsWindow(target: SettingsTarget = {}): Promise<void> {
  return invoke("settings_open", target);
}
