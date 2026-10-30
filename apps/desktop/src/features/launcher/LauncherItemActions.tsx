import { PinIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import type { LauncherItem, LauncherItemAction } from "./types";

// Compose the existing menu/button primitives around the same domain actions.
export function LauncherItemActions({
  item,
  presentation,
  ready,
  busy,
  executing,
  mutatePreference,
  editAliases,
  selectAction,
}: {
  item: LauncherItem;
  presentation: "menu" | "dialog";
  ready: boolean;
  busy: boolean;
  executing: string[];
  mutatePreference: (
    item: LauncherItem,
    operation: "pin" | "unpin" | "hide" | "show",
  ) => Promise<void>;
  editAliases: (item: LauncherItem) => void;
  selectAction: (item: LauncherItem, action: LauncherItemAction) => Promise<void>;
}) {
  const { t } = useTranslation();
  const preference = item.preference;
  const actions = [
    ...(preference
      ? [
          {
            id: "pin",
            title: t(preference.pinned ? "launcher.preferences.unpin" : "launcher.preferences.pin"),
            icon: <PinIcon aria-hidden="true" />,
            disabled: busy || !ready,
            run: () => void mutatePreference(item, preference.pinned ? "unpin" : "pin"),
          },
          {
            id: "aliases",
            title: t("launcher.preferences.editAliases"),
            disabled: busy || !ready,
            run: () => editAliases(item),
          },
          ...(preference.kind === "command" && item.kind !== "application"
            ? [
                {
                  id: "hide",
                  title: t(
                    preference.hidden ? "launcher.preferences.show" : "launcher.preferences.hide",
                  ),
                  disabled: busy || !ready,
                  run: () => void mutatePreference(item, preference.hidden ? "show" : "hide"),
                },
              ]
            : []),
        ]
      : []),
    ...(item.actions ?? []).map((action) => ({
      id: `action:${action.id}`,
      title: action.title,
      disabled:
        busy ||
        !ready ||
        !!item.unavailable ||
        executing.includes(JSON.stringify([item.pluginId, action.id])),
      run: () => void selectAction(item, action),
    })),
  ];
  return actions.map((action) =>
    presentation === "menu" ? (
      <ContextMenuItem key={action.id} disabled={action.disabled} onClick={action.run}>
        {"icon" in action ? action.icon : null}
        {action.title}
      </ContextMenuItem>
    ) : (
      <Button
        key={action.id}
        variant="outline"
        className="justify-start"
        disabled={action.disabled}
        onClick={action.run}
      >
        {"icon" in action ? action.icon : null}
        {action.title}
      </Button>
    ),
  );
}
