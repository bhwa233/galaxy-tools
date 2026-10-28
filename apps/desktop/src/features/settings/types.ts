export type ViewMode = "edit" | "split";

export type ThemeOption = "light" | "dark" | "system";

export type TileColorMode = "system" | "custom";
export type BackgroundFit = "cover" | "contain" | "repeat";
export type ImageDisplayMode = "show" | "click" | "hidden";
export type McpPermission = "read" | "append" | "full";

export interface AppConfig {
  locale: string;
  dataDir: string;
  globalShortcut: string;
  commandShortcuts?: Record<string, string>;
  trayMenu?: { hidden: string[]; order: string[] };
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

export interface ShortcutCheckResult {
  available: boolean;
  conflictType: "none" | "current" | "invalid" | "system" | "registered" | "unknown";
  message: string;
}

export type SettingsPage =
  | "general"
  | "shortcuts"
  | "tray"
  | "entries"
  | "plugins"
  | "backup"
  | "diagnostics";
export interface SettingsTarget {
  page?: SettingsPage;
  pluginId?: string;
  tab?: "config" | "functions" | "matching" | "info";
}
export interface HookKeyEvent {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}
