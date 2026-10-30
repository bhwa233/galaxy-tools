export declare const THEME_VERSION = "1.0.0";
export declare function applyPluginTheme(
  theme: {
    version: "1.0.0";
    effective: "light" | "dark";
    preference: "light" | "dark" | "system";
    accent?: "green" | "blue" | "purple" | "orange" | "rose";
  },
  root?: HTMLElement,
): void;
