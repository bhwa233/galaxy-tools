import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/desktop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { BackupSchedule } from "../../../shared/backup-schedule";
import { useUnsavedChanges } from "../settings/useUnsavedChanges";

export function BackupSchedulePanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<BackupSchedule>();
  const [enabled, setEnabled] = useState(false),
    [intervalDays, setIntervalDays] = useState(1),
    [keep, setKeep] = useState(7);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const adopt = (value: BackupSchedule) => {
    setState(value);
    setEnabled(value.enabled);
    setIntervalDays(value.intervalDays);
    setKeep(value.keep);
  };
  const report = (value: unknown) =>
    setError(
      value && typeof value === "object" && "message" in value
        ? String(value.message)
        : String(value),
    );
  useEffect(() => {
    let active = true;
    void invoke("backup_schedule", { action: "get" })
      .then((value) => {
        if (active) adopt(value);
      })
      .catch((value) => {
        if (active) report(value);
      });
    return () => {
      active = false;
    };
  }, []);
  const dirty =
    !!state &&
    (enabled !== state.enabled || intervalDays !== state.intervalDays || keep !== state.keep);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      adopt(await invoke("backup_schedule", { action: "save", enabled, intervalDays, keep }));
    } catch (value) {
      report(value);
      throw value;
    } finally {
      setBusy(false);
    }
  };
  const guard = useUnsavedChanges(dirty, save, () => {
    if (state) adopt(state);
  });
  const run = async (action: "choose" | "run") => {
    setBusy(true);
    setError(undefined);
    try {
      if (dirty) await save();
      adopt(await invoke("backup_schedule", { action }));
    } catch (value) {
      report(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={t("backupSchedule.title")}
    >
      {guard.dialog}
      <h3 className="text-sm font-medium">{t("backupSchedule.title")}</h3>
      <FieldGroup>
        <Field orientation="horizontal">
          <Checkbox
            id="scheduled-enabled"
            checked={enabled}
            disabled={busy || !state?.directory}
            onCheckedChange={(value) => setEnabled(value === true)}
          />
          <FieldLabel htmlFor="scheduled-enabled">{t("backupSchedule.enabled")}</FieldLabel>
        </Field>
        <Field>
          <FieldDescription>{t("backupSchedule.description")}</FieldDescription>
          <p className="break-all text-xs">{state?.directory || t("backupSchedule.noDirectory")}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !state}
            onClick={() => void run("choose")}
          >
            {t("backupSchedule.choose")}
          </Button>
        </Field>
        <Field>
          <FieldLabel htmlFor="backup-days">{t("backupSchedule.interval")}</FieldLabel>
          <Input
            id="backup-days"
            type="number"
            min={1}
            max={30}
            value={intervalDays}
            disabled={busy}
            onChange={(event) => setIntervalDays(Number(event.target.value))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="backup-keep">{t("backupSchedule.keep")}</FieldLabel>
          <Input
            id="backup-keep"
            type="number"
            min={1}
            max={100}
            value={keep}
            disabled={busy}
            onChange={(event) => setKeep(Number(event.target.value))}
          />
        </Field>
      </FieldGroup>
      <p role="status" className="text-xs text-muted-foreground">
        {t("backupSchedule.lastSuccess")}:{" "}
        {state?.lastSuccess
          ? new Date(state.lastSuccess).toLocaleString()
          : t("backupSchedule.never")}
      </p>
      {(error || state?.lastError) && (
        <Alert variant="destructive">
          <AlertDescription>{error || state?.lastError}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={
            !dirty || busy || intervalDays < 1 || intervalDays > 30 || keep < 1 || keep > 100
          }
          onClick={() => void guard.save().catch(() => {})}
        >
          {t("settingsEditor.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !state?.directory}
          onClick={() => void run("run")}
        >
          {t("backupSchedule.run")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void invoke("backup_schedule", { action: "get" })
              .then((next) => {
                setState(next);
                setError(undefined);
              })
              .catch(report);
          }}
        >
          {t("backupSchedule.refresh")}
        </Button>
      </div>
    </section>
  );
}
