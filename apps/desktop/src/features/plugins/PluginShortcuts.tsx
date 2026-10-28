import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { openSettingsWindow } from "../settings/api";
import type { PluginSummary } from "./types";

export function PluginShortcuts({ plugin }: { plugin: PluginSummary }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        onClick={() => {
          void openSettingsWindow({ page: "shortcuts", pluginId: plugin.pluginId }).catch((value) =>
            setError(value.message),
          );
        }}
      >
        {t("commandSettings.manageShortcuts")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
