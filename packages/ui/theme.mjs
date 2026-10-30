export const THEME_VERSION = "1.0.0";
export function applyPluginTheme(theme, root = document.documentElement) {
  if (theme?.version !== THEME_VERSION || !["light", "dark"].includes(theme.effective))
    throw new Error("Unsupported spark233 theme contract");
  root.dataset.theme = theme.effective;
  root.dataset.accent = theme.accent ?? "green";
  root.style.colorScheme = theme.effective;
}
