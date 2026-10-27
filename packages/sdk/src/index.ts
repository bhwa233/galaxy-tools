export * from "./manifest.js";
export * from "./native-protocol.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface PluginOwner {
  pluginId: string;
  version: string;
  instanceId: string;
}
export type StopReason = "disable" | "update" | "uninstall" | "quit" | "crash";
export interface ResourceHandle {
  id: string;
  kind: "image" | "file" | "text";
  mimeType?: string;
  size?: number;
}
export type PluginContext = (
  | { kind: "text"; text: string }
  | { kind: "image"; resource: ResourceHandle }
  | { kind: "files"; resources: ResourceHandle[] }
  | { kind: "window"; sourceApplication: string }
) & { sourceApplication?: string };
export interface PluginActivation {
  commandId?: string;
  context?: PluginContext;
  parameters?: JsonValue;
}
/** Runs in a separate trusted worker before the normal backend is initialized. */
export interface PluginDataMigration {
  fromDataVersion: number;
  toDataVersion: number;
  fromPluginVersion: string;
  toPluginVersion: string;
}
export interface PluginMigrationContext extends PluginDataMigration {
  dataDir: string;
  signal: AbortSignal;
}
export interface PluginMigrationResult {
  dataVersion: number;
}
export interface PluginTheme {
  version: "1.0.0";
  preference: "system" | "light" | "dark";
  effective: "light" | "dark";
}
export interface PluginSessionContext {
  owner: PluginOwner;
  theme: PluginTheme;
  activation?: PluginActivation;
}
export interface PluginSearchQuery {
  queryId: string;
  text: string;
  modeId: string;
  limit: number;
  cursor?: string;
  context?: PluginContext;
}
export interface PluginSearchResult {
  id: string;
  kind: "command" | "application" | "file" | "directory" | "note" | "clipboard" | "dictionary";
  title: string;
  description?: string;
  icon?: string;
  path?: string;
  snippet?: string;
  actions: Array<{ commandId: string; title: string; parameters?: JsonValue }>;
}
export interface PluginSearchPage {
  queryId: string;
  results: PluginSearchResult[];
  cursor?: string;
}
/** Local launcher candidates. Actions always name this plugin's declared commands. */
export interface PluginLauncherPage {
  items: Array<{
    id: string;
    title: string;
    description?: string;
    commandId: string;
    parameters?: JsonValue;
    kind?: string;
    icon?: string;
    actions?: Array<{ title: string; commandId: string; parameters?: JsonValue }>;
  }>;
  hint?: string;
}
export * from "./browser.js";
