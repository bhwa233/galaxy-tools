import { invoke, listen } from "../../platform/desktop";
import type { InstallPreview, PluginCommandArguments, PluginManagementState } from "./types";

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
): Promise<InstallPreview> {
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
export function preparePluginUpdate(pluginId: string): Promise<InstallPreview> {
  return invoke("plugins_prepare_update", { pluginId });
}
export function prepareBundledPlugin(pluginId: string): Promise<InstallPreview> {
  return invoke("plugins_prepare_bundled", { pluginId });
}
export function watchPluginsChanged(callback: () => void): Promise<() => void> {
  return listen("plugins-changed", callback);
}
