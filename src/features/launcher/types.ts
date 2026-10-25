import type { PluginContext } from "../../../packages/sdk/src/index.js";

export interface LauncherCommand {
  id: string;
  pluginId: string;
  title: string;
  description?: string;
  keywords: string[];
  /** Opaque host routing key; the frontend sends it back unchanged. */
  mode?: string;
  enabled: boolean;
}
export interface LauncherState {
  firstRun: boolean;
  commands: LauncherCommand[];
  pluginsReady: boolean;
  contextLabel?: string;
  warnings?: string[];
  modeOptions?: Record<string, { directoryFilter: boolean; placeholder?: string }>;
}
export interface LauncherItem {
  id: string;
  pluginId: string;
  title: string;
  description?: string;
  commandId?: string;
  context?: PluginContext;
  kind?: string;
  usage?: { count: number; lastUsedAt: number };
  icon?: string;
  actions?: LauncherItemAction[];
}
export interface LauncherItemAction {
  id: string;
  title: string;
  commandId: string;
}
export interface LauncherQueryResult {
  sessionId: string;
  items: LauncherItem[];
  hint?: string;
}
