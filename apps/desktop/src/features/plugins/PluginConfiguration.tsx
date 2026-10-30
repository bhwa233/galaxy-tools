import { showToast } from "../../components/Toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldGroup, FieldDescription } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { SlidingButtonGroup } from "@/components/SlidingButtonGroup";
import { SettingsPanel } from "@/components/SettingsPanel";
import { getConfig } from "../settings/api";
import type { AppConfig } from "../settings/types";
import { useUnsavedChanges } from "../settings/useUnsavedChanges";
import { SettingsFooter } from "../settings/SettingsFooter";
import { activatePlugin, getPluginSettings, savePluginSettings } from "./api";
import type { PluginSettingsSnapshot } from "./settingsTypes";

export function PluginConfiguration({
  pluginId,
  footerVisible = true,
}: {
  pluginId: string;
  footerVisible?: boolean;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<PluginSettingsSnapshot>();
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [appConfig, setAppConfig] = useState<AppConfig>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoading(true);
    setError(undefined);
    setSnapshot(undefined);
    setPatch({});
    void Promise.all([
      getPluginSettings(pluginId),
      pluginId === "spark233.notes" ? getConfig() : Promise.resolve(undefined),
    ])
      .then(([settings, config]) => {
        if (active) {
          setSnapshot(settings);
          setAppConfig(config);
        }
      })
      .catch((value) => {
        if (active) setError(value?.message ?? String(value));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [pluginId, retry]);
  const dirty = Object.keys(patch).length > 0;
  const save = async () => {
    if (!snapshot) throw new Error(t("pluginConfig.loadFirst"));
    if (!dirty) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await savePluginSettings(pluginId, snapshot.revision, patch);
      setSnapshot(result);
      setPatch({});
      setSaved(true);
      showToast(t("notifications.saved", { ns: "translation" }), "success");
    } catch (value) {
      setError((value as Error)?.message ?? String(value));
      throw value;
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    setPatch({});
    setSaved(false);
    setRetry((value) => value + 1);
  };
  const guard = useUnsavedChanges(dirty, save, discard);
  const change = (key: string, value: unknown) => {
    setSaved(false);
    setPatch((previous) => {
      const next = { ...previous };
      if (
        snapshot?.values[key] !== undefined &&
        JSON.stringify(value) === JSON.stringify(snapshot.values[key])
      )
        delete next[key];
      else next[key] = value;
      return next;
    });
  };
  const values = { ...snapshot?.values, ...patch };
  return (
    <div className="flex min-h-0 flex-col gap-5">
      {guard.dialog}
      {loading && (
        <p role="status" className="flex items-center gap-2">
          <Spinner />
          {t("pluginConfig.loading")}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !snapshot && (
        <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
          {t("launcher.retry")}
        </Button>
      )}
      {snapshot && (
        <>
          {pluginId === "spark233.applications" && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  void activatePlugin(pluginId, "refresh")
                    .then(() => showToast(t("notifications.refreshed"), "success"))
                    .catch((value) =>
                      setError(value instanceof Error ? value.message : String(value)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {t("launcher.refreshApplications")}
              </Button>
            </div>
          )}
          {!snapshot.fields.length && (
            <p className="text-sm text-muted-foreground">{t("pluginConfig.noSettings")}</p>
          )}
          {pluginId === "spark233.notes" && appConfig ? (
            <fieldset disabled={busy} className="min-h-[420px]">
              <SettingsPanel
                presentation="content"
                initialGroup="notes"
                config={{ ...appConfig, ...values } as AppConfig}
                onChange={(next) => {
                  for (const [key, value] of Object.entries(next)) change(key, value);
                }}
                onClose={() => {}}
                onMigrateDataDir={() => {}}
              />
            </fieldset>
          ) : (
            <FieldGroup>
              {snapshot.fields.map((field) => {
                const id = `plugin-${field.key}`,
                  value = values[field.key];
                return (
                  <Field key={field.key} data-disabled={busy}>
                    <FieldLabel htmlFor={id}>
                      {t(field.label, { defaultValue: field.key })}
                    </FieldLabel>
                    {field.type === "boolean" ? (
                      <Checkbox
                        id={id}
                        checked={value === true}
                        disabled={busy}
                        onCheckedChange={(next) => change(field.key, next === true)}
                      />
                    ) : field.type === "select" ? (
                      <SlidingButtonGroup
                        value={String(value ?? "")}
                        options={(field.options ?? []).map((option) => ({
                          value: option,
                          label: t(`pluginConfig.options.${option}`, { defaultValue: option }),
                        }))}
                        onChange={(next) => change(field.key, next)}
                      />
                    ) : field.type === "lines" ? (
                      <Textarea
                        id={id}
                        disabled={busy}
                        rows={4}
                        placeholder={t("pluginConfig.linesPlaceholder")}
                        value={Array.isArray(value) ? value.join("\n") : ""}
                        onChange={(event) =>
                          change(
                            field.key,
                            event.target.value.split(/\r?\n/).filter((line) => line.trim()),
                          )
                        }
                      />
                    ) : (
                      <Input
                        id={id}
                        disabled={busy}
                        type={
                          field.type === "secret"
                            ? "password"
                            : field.type === "number"
                              ? "number"
                              : "text"
                        }
                        autoComplete={field.type === "secret" ? "new-password" : "off"}
                        value={String(value ?? "")}
                        min={field.min}
                        max={field.max}
                        onChange={(event) => {
                          if (field.type === "secret" && event.target.value === "") {
                            setPatch((previous) => {
                              const next = { ...previous };
                              delete next[field.key];
                              return next;
                            });
                            setSaved(false);
                            return;
                          }
                          change(
                            field.key,
                            field.type === "number"
                              ? event.target.value === "" && field.nullable
                                ? null
                                : Number(event.target.value)
                              : event.target.value,
                          );
                        }}
                      />
                    )}
                    {field.type === "secret" && (
                      <div className="flex flex-col gap-2">
                        <FieldDescription>
                          {t(
                            Object.hasOwn(patch, field.key) && patch[field.key] === ""
                              ? "pluginConfig.secretClearing"
                              : snapshot.hasSecret
                                ? "pluginConfig.secretSet"
                                : "pluginConfig.secretEmpty",
                          )}
                        </FieldDescription>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => change(field.key, "")}
                        >
                          {t("translation.clearKey")}
                        </Button>
                      </div>
                    )}
                    {field.nullable && (
                      <FieldDescription>{t("pluginConfig.emptyUnlimited")}</FieldDescription>
                    )}
                  </Field>
                );
              })}
            </FieldGroup>
          )}
          {!!snapshot.fields.length && footerVisible && (
            <SettingsFooter
              statusTestId="plugin-save-status"
              status={t(
                busy
                  ? "launcher.preferences.saving"
                  : dirty
                    ? "settingsEditor.unsaved"
                    : saved
                      ? "pluginConfig.saved"
                      : "pluginConfig.explicitSave",
              )}
            >
              <Button variant="outline" disabled={busy || !dirty} onClick={discard}>
                {t("settingsEditor.discard")}
              </Button>
              <Button
                disabled={busy || !dirty}
                onClick={() => {
                  void guard.save().catch(() => {});
                }}
              >
                {busy && <Spinner />}
                {t("settingsEditor.save")}
              </Button>
            </SettingsFooter>
          )}
        </>
      )}
    </div>
  );
}
