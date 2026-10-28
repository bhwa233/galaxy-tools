import { invoke, listen } from "../../platform/desktop";
import type {
  InstallPreview,
  PackageTaskSnapshot,
  PluginCommandArguments,
  PluginManagementState,
  PluginReleaseNotes,
} from "./types";

export function listPlugins(): Promise<PluginManagementState> {
  return invoke("plugins_list");
}
export function importPluginPackage(): Promise<InstallPreview | undefined> {
  return invoke("plugins_import");
}
export function importPluginDirectory(): Promise<InstallPreview | undefined> {
  return invoke("plugins_import_directory");
}
export function prepareRegistryPlugin(
  input: PluginCommandArguments["plugins_prepare_registry"],
): Promise<InstallPreview | undefined> {
  return invoke("plugins_prepare_registry", input);
}
export function confirmPluginInstall(
  previewId: string,
  trustNative: boolean,
): Promise<PluginManagementState> {
  return invoke("plugins_confirm_install", { previewId, trustNative });
}
export function cancelPluginInstall(previewId: string): Promise<PluginManagementState> {
  return invoke("plugins_cancel_install", { previewId });
}
export function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<PluginManagementState> {
  return invoke("plugins_enable", { pluginId, enabled });
}
export function activatePlugin(
  pluginId: string,
  commandId?: string,
): Promise<PluginManagementState> {
  return invoke("plugins_activate", { pluginId, ...(commandId ? { commandId } : {}) });
}
export function uninstallPlugin(
  pluginId: string,
  deleteData: boolean,
): Promise<PluginManagementState> {
  return invoke("plugins_uninstall", { pluginId, deleteData });
}
export function checkPluginUpdates(): Promise<PluginManagementState> {
  return invoke("plugins_check_updates");
}
export function preparePluginUpdate(pluginId: string): Promise<InstallPreview | undefined> {
  return invoke("plugins_prepare_update", { pluginId });
}
export function prepareBundledPlugin(pluginId: string): Promise<InstallPreview | undefined> {
  return invoke("plugins_prepare_bundled", { pluginId });
}
export function watchPluginsChanged(callback: () => void): Promise<() => void> {
  return listen("plugins-changed", callback);
}
export function cancelPluginPackageTask(taskId: string): Promise<PackageTaskSnapshot> {
  return invoke("plugins_cancel_package_task", { taskId });
}
export function getPluginReleaseNotes(pluginId: string): Promise<PluginReleaseNotes> {
  return invoke("plugins_release_notes", { pluginId });
}
export function watchPluginPackageTasks(
  callback: (snapshot: PackageTaskSnapshot) => void,
): Promise<() => void> {
  return listen("plugin-package-task-changed", ({ payload }) => callback(payload));
}

export function getPluginSettings(
  pluginId: string,
): Promise<import("./settingsTypes").PluginSettingsSnapshot> {
  return invoke("plugin_settings_get", { pluginId });
}
export function savePluginSettings(
  pluginId: string,
  revision: string,
  patch: Record<string, unknown>,
): Promise<import("./settingsTypes").PluginSettingsSnapshot> {
  return invoke("plugin_settings_save", { pluginId, revision, patch });
}
