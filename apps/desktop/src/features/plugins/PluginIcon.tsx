import {
  AppWindow,
  ClipboardList,
  Languages,
  ScanLine,
  ScanText,
  Search,
  StickyNote,
  Puzzle,
  type LucideIcon,
} from "lucide-react";

// Share the installed Lucide library between launcher entries and management;
// plugin IDs select trusted local components, never arbitrary SVG from packages.
const icons: Record<string, LucideIcon> = {
  "spark233.applications": AppWindow,
  "spark233.clipboard": ClipboardList,
  "spark233.notes": StickyNote,
  "spark233.translation": Languages,
  "spark233.search": Search,
  "spark233.screenshot": ScanLine,
  "spark233.ocr": ScanText,
};
// Only a plugin's main entry belongs in the icon grid. Its other commands,
// such as creating a note or pausing recording, remain ordinary search results.
export const pluginEntryCommands: Record<string, string> = {
  "spark233.applications": "search",
  "spark233.clipboard": "history",
  "spark233.notes": "open",
  "spark233.translation": "search",
  "spark233.search": "search",
  "spark233.screenshot": "capture",
  "spark233.ocr": "ocr",
};
export function PluginIcon({ pluginId, className }: { pluginId: string; className?: string }) {
  const Icon = icons[pluginId] ?? Puzzle;
  return <Icon aria-hidden="true" className={className} strokeWidth={1.75} />;
}
