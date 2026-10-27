export interface ContextPanelStatus {
  supported: boolean;
  phase: "disabled" | "starting" | "ready" | "unavailable";
}

export interface ContextPanelViewState {
  sessionId: string;
  revision: number;
  status: "capturing" | "ready" | "no-context" | "error";
  contextKind?: "text" | "image" | "files" | "window";
  sourceApp?: string;
  reason?: "empty" | "denied" | "changed" | "timeout" | "unavailable";
  suggestedQuery?: string;
  returnAvailable: boolean;
}
