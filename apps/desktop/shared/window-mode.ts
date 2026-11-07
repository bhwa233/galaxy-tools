/** Mutually exclusive plugin window modes (Docs/plugin-window-status-bar.md). */
export type WindowMode = "normal" | "topmost" | "desktop";

/** Status bar state the host pushes to a plugin window's trusted shell page. */
export interface PluginShellState {
  title: string;
  maximized: boolean;
  maximizable: boolean;
  locale: string;
  theme: { effective: "light" | "dark"; accent?: string };
  mode: WindowMode;
  desktopAvailable: boolean;
}
