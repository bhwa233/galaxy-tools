/** Mutually exclusive plugin window modes (Docs/plugin-window-status-bar.md). */
export type WindowMode = "normal" | "topmost" | "desktop";

/** Mode state of one window, as its status bar shows it. */
export interface WindowModeState {
  mode: WindowMode;
  desktopAvailable: boolean;
  /** Desktop card locked in place. */
  locked?: boolean;
  /** One-time hint after the first move to the desktop: the overlay shortcut. */
  hint?: string;
  /** Briefly true after opening the window located its existing desktop card. */
  highlighted?: boolean;
}

/** Status bar state the host pushes to a plugin window's trusted shell page. */
export interface PluginShellState extends WindowModeState {
  title: string;
  maximized: boolean;
  maximizable: boolean;
  locale: string;
  theme: { effective: "light" | "dark"; accent?: string };
  /** Plugin-provided plain-text context (Host API 1.7 window.status). */
  subtitle?: string;
  runState?: "unsaved" | "busy" | "error";
  /** Desktop card bar folded to a thin strip; the page fills the window. */
  barCollapsed?: boolean;
}
