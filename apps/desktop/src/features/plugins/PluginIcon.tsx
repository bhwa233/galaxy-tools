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
export { pluginEntryCommands, pluginKeywordOnlyCommands } from "../../../shared/launcher-entries";

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
export function PluginIcon({ pluginId, className }: { pluginId: string; className?: string }) {
  const Icon = icons[pluginId] ?? Puzzle;
  return <Icon aria-hidden="true" className={className} strokeWidth={1.75} />;
}
