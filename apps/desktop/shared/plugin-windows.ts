import type { PluginOwner } from "@spark233/sdk";

export interface PluginWindowActivation {
  revision: number;
  owner: PluginOwner;
  payload: unknown;
}
export interface PluginWindowInfo {
  pluginId: string;
  profile: string;
  title: string;
  icon?: string;
  presentation: "standard" | "compact";
  maximizable?: boolean;
  commands: string[];
}
