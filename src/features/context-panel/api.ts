import { invoke, listen } from "../../platform/desktop";
import type { ContextPanelStatus, ContextPanelViewState } from "./types";

export function getContextPanelStatus(): Promise<ContextPanelStatus> {
  return invoke("super_panel_status");
}
export function retryContextPanel(): Promise<ContextPanelStatus> {
  return invoke("super_panel_retry");
}
export function getContextPanelState(): Promise<ContextPanelViewState | undefined> {
  return invoke("super_panel_state");
}
export function closeContextPanel(): Promise<void> {
  return invoke("super_panel_close");
}
export function returnFromContextPanel(): Promise<{ restored: boolean }> {
  return invoke("super_panel_return");
}
export function openContextPanel(): Promise<void> {
  return invoke("super_panel_open");
}
export function watchContextPanelStatus(
  callback: (status: ContextPanelStatus) => void,
): Promise<() => void> {
  return listen<ContextPanelStatus>("super-panel-status", ({ payload }) => callback(payload));
}
export function watchContextPanelState(
  callback: (state: ContextPanelViewState) => void,
): Promise<() => void> {
  return listen<ContextPanelViewState>("super-panel-state", ({ payload }) => callback(payload));
}
