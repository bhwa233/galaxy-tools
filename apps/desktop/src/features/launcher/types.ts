import type { PluginContext } from "@spark233/sdk";

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
  catalogSignature?: string;
  commands: LauncherCommand[];
  pluginsReady: boolean;
  contextLabel?: string;
  contextRevision?: number;
  warnings?: string[];
  preferenceRevision?: number;
  preferences?: LauncherPreferenceEntry[];
  learning?: { enabled: boolean; recordCount: number };
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
  preference?: LauncherPreferenceEntry;
  unavailable?: boolean;
  learned?: boolean;
}
export type LauncherLearningMutation =
  | { enabled: boolean; clear?: never }
  | { clear: true; enabled?: never };
export interface LauncherPreferenceEntry {
  key: string;
  kind: "command" | "application";
  pluginId: string;
  commandId?: string;
  title: string;
  description?: string;
  available: boolean;
  pinned: boolean;
  hidden: boolean;
  aliases: string[];
}
export interface LauncherPreferenceMutation {
  /** Existing preference/catalog key or a live result token, never launch parameters. */
  key?: string;
  selectionId?: string;
  operation: "pin" | "unpin" | "aliases" | "hide" | "show" | "move-up" | "move-down" | "remove";
  aliases?: string[];
}
export interface LauncherItemAction {
  id: string;
  title: string;
  commandId: string;
}
export interface LauncherQueryResult {
  sessionId: string;
  requestId?: string;
  revision?: number;
  pending?: boolean;
  groups?: LauncherResultGroup[];
  items: LauncherItem[];
  hint?: string;
  instructions?: string;
}
export interface LauncherResultGroup {
  id: string;
  title: string;
  pluginId?: string;
  status: "pending" | "ready" | "error";
  items: LauncherItem[];
  hint?: string;
  instructions?: string;
}
