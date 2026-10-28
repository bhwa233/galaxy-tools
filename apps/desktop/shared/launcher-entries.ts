export const pluginEntryCommands: Record<string, string> = {
  "spark233.applications": "search",
  "spark233.clipboard": "history",
  "spark233.notes": "open",
  "spark233.translation": "search",
  "spark233.search": "search",
  "spark233.screenshot": "history",
};

// One-shot actions belong to the operation list, not to the plugin tile: the tile
// is the plugin's own view (history), these run once and end.
export const pluginActionCommands: Record<string, readonly string[]> = {
  "spark233.screenshot": ["capture", "ocr"],
};

// These controls belong to a plugin or an active task, not general search.
export const pluginManagedCommands: Record<string, readonly string[]> = {
  "spark233.applications": ["refresh"],
  "spark233.clipboard": ["pause", "quick"],
  "spark233.screenshot": ["cancel"],
  "spark233.ocr": ["cancel"],
  "spark233.translation": ["translate"],
};
