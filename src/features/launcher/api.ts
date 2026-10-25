import { invoke } from "../../platform/desktop";
import type { LauncherItem, LauncherItemAction, LauncherQueryResult, LauncherState } from "./types";

export function getLauncherState(): Promise<LauncherState> {
  return invoke("launcher_state");
}
export function queryLauncher(
  query: string,
  sessionId: string,
  mode?: string,
  directory?: string,
): Promise<LauncherQueryResult> {
  return invoke("launcher_query", {
    query,
    sessionId,
    ...(mode ? { mode } : {}),
    ...(directory ? { directory } : {}),
  });
}
export function pickLauncherDirectory(): Promise<string | undefined> {
  return invoke("launcher_pick_directory");
}
export function recordLauncherMode(mode: string): Promise<void> {
  return invoke("launcher_enter_mode", { mode });
}
export function executeLauncherItem(item: LauncherItem): Promise<unknown> {
  return invoke("launcher_execute", {
    id: item.id,
    pluginId: item.pluginId,
    ...(item.commandId ? { commandId: item.commandId } : {}),
    ...(item.context ? { context: item.context } : {}),
  });
}
export function executeLauncherAction(
  item: LauncherItem,
  action: LauncherItemAction,
): Promise<unknown> {
  return invoke("launcher_execute", {
    id: action.id,
    pluginId: item.pluginId,
    commandId: action.commandId,
  });
}
export function completeLauncherOnboarding(): Promise<unknown> {
  return invoke("launcher_complete_onboarding");
}
export function hideLauncher(): Promise<void> {
  return invoke("launcher_hide");
}
