export interface PluginSettingsField {
  key: string;
  label: string;
  type: "boolean" | "number" | "text" | "lines" | "select" | "secret";
  min?: number;
  max?: number;
  nullable?: boolean;
  options?: string[];
}
export interface PluginSettingsSnapshot {
  pluginId: string;
  revision: string;
  fields: PluginSettingsField[];
  values: Record<string, unknown>;
  hasSecret?: boolean;
}
