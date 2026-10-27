export type ViewMode = "edit" | "split";

export type ThemeOption = "light" | "dark" | "system";

export type TileColorMode = "system" | "custom";
export type BackgroundFit = "cover" | "contain" | "repeat";
export type ImageDisplayMode = "show" | "click" | "hidden";
export type McpPermission = "read" | "append" | "full";
export type SuperPanelButton = "middle" | "x1" | "x2";
export type SuperPanelTrigger = "click" | "hold";

export interface AppConfig {
  locale: string;
  dataDir: string;
  globalShortcut: string;
  commandShortcuts?: Record<string, string>;
  closeToTray: boolean;
  autostart: boolean;
  defaultViewMode: string;
  noteAutoSave: boolean;
  noteSurfaceAutoSave: boolean;
  tileColor: string;
  tileColorMode: TileColorMode;
  theme: ThemeOption;
  fontSize: number;
  surfaceFontSize: number;
  tabIndentSize: number;
  externalFileAutoSave: boolean;
  rememberSurfaceSize: boolean;
  tileCtrlClose: boolean;
  tileDoubleClickToEdit: boolean;
  tileSaveReturnsToPin: boolean;
  renderHtmlMarkdown: boolean;
  splitScrollSync: boolean;
  imageAutoCompress: boolean;
  imageDisplay: ImageDisplayMode;
  reminderSound: boolean;
  mcpEnabled: boolean;
  mcpPermission: McpPermission;
  superPanelEnabled: boolean;
  superPanelButton: SuperPanelButton;
  superPanelTrigger: SuperPanelTrigger;
  superPanelHoldMs: number;
  superPanelExcludedApps: string[];
  superPanelCopyFallback: boolean;
  surfaceWidth?: number;
  surfaceHeight?: number;
  toggleVisibilityShortcut: string;
  openAtCursor: boolean;
  backgroundImagePath?: string;
  backgroundFit?: BackgroundFit;
  backgroundDim?: number;
  backgroundBlur?: number;
  backgroundScale?: number;
  backgroundPositionX?: number;
  backgroundPositionY?: number;
}

/** The data root changes only through the coordinated migration transaction. */
export type AppConfigPatch = Partial<Omit<AppConfig, "dataDir">>;
