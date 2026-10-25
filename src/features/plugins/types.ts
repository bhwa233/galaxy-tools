import type {
  PluginCapability,
  PluginCommand,
  PluginPackageMetadata,
} from "../../../packages/sdk/src/index.js";

export interface PluginPackageSource {
  kind: "registry" | "file" | "directory";
  location: string;
  registry?: string;
  channel?: string;
}
export interface PluginUpdateSource {
  registry: string;
  channel: string;
}
export interface PluginSummary {
  pluginId: string;
  packageName: string;
  displayName: string;
  version: string;
  enabled: boolean;
  status: string;
  source: PluginPackageSource;
  updateSource?: PluginUpdateSource;
  capabilities: PluginCapability[];
  commands: PluginCommand[];
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  lastError?: string;
}
export interface InstallPreview {
  previewId: string;
  metadata: PluginPackageMetadata;
  source: PluginPackageSource;
  integrity: string;
  requiresNativeTrust: boolean;
  createdAt: number;
}
export interface UpdateSummary {
  pluginId: string;
  currentVersion: string;
  version: string;
  packageName: string;
  source: PluginPackageSource;
}
export interface PluginManagementState {
  plugins: PluginSummary[];
  catalog: BundledPluginCatalogItem[];
  pending: InstallPreview[];
  updates: UpdateSummary[];
  checking: boolean;
  lastChecked?: number;
  error?: string;
}
export interface BundledPluginCatalogItem {
  pluginId: string;
  packageName: string;
  displayName: string;
  version: string;
  installedVersion?: string;
  pending: boolean;
  canPrepare: boolean;
}
export interface PluginCommandArguments {
  plugins_list: undefined;
  plugins_import: undefined;
  plugins_import_directory: undefined;
  plugins_prepare_registry: { name: string; registry?: string; channel?: string };
  plugins_prepare_bundled: { pluginId: string };
  plugins_confirm_install: { previewId: string; trustNative: boolean };
  plugins_cancel_install: { previewId: string };
  plugins_enable: { pluginId: string; enabled: boolean };
  plugins_activate: { pluginId: string; commandId?: string };
  plugins_uninstall: { pluginId: string; deleteData: boolean };
  plugins_check_updates: undefined;
  plugins_prepare_update: { pluginId: string };
}
