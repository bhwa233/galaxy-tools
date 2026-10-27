import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShortcutRecorder } from "@/components/SettingsPanel";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getConfig, patchConfig } from "../settings/api";
import { useUnsavedChanges } from "../settings/useUnsavedChanges";
import type { PluginSummary } from "./types";

export function PluginShortcuts({ plugin }: { plugin: PluginSummary }) {
  const { t } = useTranslation();
  const [baseline, setBaseline] = useState<Record<string, string>>();
  const [patch, setPatch] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void getConfig()
      .then((config) => {
        if (active)
          setBaseline(
            Object.fromEntries(
              plugin.commands.map((command) => {
                const key = `${plugin.pluginId}:${command.id}`;
                return [key, config.commandShortcuts?.[key] ?? ""];
              }),
            ),
          );
      })
      .catch((value) => {
        if (active) setError(value?.message ?? String(value));
      });
    return () => {
      active = false;
    };
  }, [plugin.pluginId]);
  const dirty = Object.keys(patch).length > 0;
  const save = async () => {
    if (!baseline) throw new Error(t("pluginConfig.loadFirst"));
    if (!dirty) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await patchConfig(
        { commandShortcuts: patch },
        { expectedCommandShortcuts: baseline },
      );
      setBaseline(
        Object.fromEntries(
          Object.keys(baseline).map((key) => [key, result.commandShortcuts?.[key] ?? ""]),
        ),
      );
      setPatch({});
    } catch (value) {
      setError((value as Error)?.message ?? String(value));
      throw value;
    } finally {
      setBusy(false);
    }
  };
  const guard = useUnsavedChanges(dirty, save, () => setPatch({}));
  return (
    <section className="flex flex-col gap-4 border-t pt-4">
      {guard.dialog}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <fieldset disabled={busy || !baseline} className="flex flex-col gap-4">
        {plugin.commands.map((command) => {
          const key = `${plugin.pluginId}:${command.id}`;
          return (
            <ShortcutRecorder
              key={key}
              label={command.title}
              value={patch[key] ?? baseline?.[key] ?? ""}
              onChange={(value) =>
                setPatch((previous) => {
                  const next = { ...previous };
                  if (value === baseline?.[key]) delete next[key];
                  else next[key] = value;
                  return next;
                })
              }
            />
          );
        })}
      </fieldset>
      {dirty && (
        <footer className="flex items-center gap-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {t("settingsEditor.unsaved")}
          </span>
          <Button variant="outline" disabled={busy} onClick={() => setPatch({})}>
            {t("settingsEditor.discard")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void guard.save().catch(() => {});
            }}
          >
            {t("settingsEditor.save")}
          </Button>
        </footer>
      )}
    </section>
  );
}
