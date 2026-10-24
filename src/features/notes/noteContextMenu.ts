import { t, type TFunction } from "i18next";
import type { NoteWindowState } from "../windows/noteWindowState";

export type NoteContextMenuAction =
  | "desktop"
  | "pin"
  | "reminder"
  | "hide"
  | "export"
  | "move"
  | "delete";

export interface NoteContextMenuItem {
  action: NoteContextMenuAction;
  label: string;
  tone?: "danger";
}

export function getNoteContextMenuItems(
  translate: TFunction = t,
  state?: NoteWindowState,
): NoteContextMenuItem[] {
  return [
    { action: "desktop", label: translate("noteMenu.showOnDesktop", { defaultValue: "贴到桌面" }) },
    { action: "pin", label: translate(state?.pinned ? "noteState.unpin" : "noteState.pin") },
    { action: "reminder", label: translate("noteMenu.setReminder", { defaultValue: "设置提醒…" }) },
    ...(state?.presence === "desktop" || state?.presence === "capsule"
      ? [{ action: "hide" as const, label: translate("noteState.hide") }]
      : []),
    {
      action: "export",
      label: translate("noteMenu.export", { defaultValue: "导出 Markdown" }),
    },
    {
      action: "move",
      label: translate("noteMenu.moveToCategory", { defaultValue: "移动到分类…" }),
    },
    {
      action: "delete",
      label: translate("noteMenu.delete", { defaultValue: "删除便签" }),
      tone: "danger",
    },
  ];
}
