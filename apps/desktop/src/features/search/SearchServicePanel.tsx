import { useUnsavedChanges } from "../settings/useUnsavedChanges";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { configureSearchService, getSearchServiceStatus, rebuildSearchService } from "./api";
import type { SearchServiceStatus } from "./types";

export function SearchServicePanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation("search");
  const [status, setStatus] = useState<SearchServiceStatus>();
  const [paths, setPaths] = useState("");
  const [volumes, setVolumes] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const displayError = error ?? readError;
  const dirty = useRef(false),
    active = useRef(false),
    operating = useRef(false),
    refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (operating.current || refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await getSearchServiceStatus();
      if (!active.current) return;
      setStatus(next);
      setReadError(undefined);
      if (!dirty.current) {
        setPaths(next.excludedRoots.join("\n"));
        setVolumes(Object.fromEntries(next.volumes.map((volume) => [volume.id, volume.enabled])));
      }
    } finally {
      refreshing.current = false;
    }
  }, []);
  useEffect(() => {
    active.current = true;
    const poll = () => {
      void refresh().catch((value: unknown) => {
        if (active.current) setReadError(message(value));
      });
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function manage(action: "configure" | "rebuild", propagate = false) {
    if (operating.current || refreshing.current) {
      if (propagate) throw new Error(t("loading"));
      return;
    }
    operating.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    try {
      const result =
        action === "configure"
          ? await configureSearchService(
              paths
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
              (status?.volumes ?? [])
                .filter((volume) => volume.supported)
                .map((volume) => ({
                  id: volume.id,
                  enabled: volumes[volume.id] ?? volume.enabled,
                })),
            )
          : await rebuildSearchService();
      if (result.status !== "ok") throw new Error(result.message || result.status);
      dirty.current = false;
      setHasChanges(false);
    } catch (value) {
      setError(message(value));
      if (propagate) throw value;
    } finally {
      operating.current = false;
      onBusyChange?.(false);
      if (active.current) {
        setBusy(false);
        await refresh().catch((value: unknown) => setReadError(message(value)));
      }
    }
  }
  const guard = useUnsavedChanges(
    hasChanges,
    () => manage("configure", true),
    () => {
      dirty.current = false;
      setHasChanges(false);
      if (status) {
        setPaths(status.excludedRoots.join("\n"));
        setVolumes(Object.fromEntries(status.volumes.map((volume) => [volume.id, volume.enabled])));
      }
    },
  );
  return (
    <section className="space-y-3 border-t pt-4" aria-label={t("serviceTitle")}>
      {guard.dialog}
      <h3 className="font-medium">{t("serviceTitle")}</h3>
      <p className="text-muted-foreground">{t("serviceHelp")}</p>
      <p role="status">{status?.message || (status ? status.status : t("loading"))}</p>
      {displayError && (
        <p role="alert" className="text-destructive">
          {displayError}
        </p>
      )}
      {status?.volumes.map((volume, index) => (
        <Field key={volume.id}>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`service-volume-${index}`}
              checked={volumes[volume.id] ?? volume.enabled}
              disabled={busy || !volume.supported}
              onCheckedChange={(value) => {
                dirty.current = true;
                setHasChanges(true);
                setVolumes((current) => ({ ...current, [volume.id]: value === true }));
              }}
            />
            <FieldLabel htmlFor={`service-volume-${index}`}>
              {volume.mountPoint} {volume.label} ({volume.fileSystem || t("unsupported")})
            </FieldLabel>
          </div>
          <FieldDescription>
            {volume.state} · {volume.indexedItems.toLocaleString()} {t("indexedItems")} ·{" "}
            {volume.online ? t("online") : t("offline")}
            {volume.error ? ` · ${volume.error}` : ""}
          </FieldDescription>
          {volume.progress > 0 && volume.progress < 100 && (
            <progress max={100} value={volume.progress} aria-label={volume.mountPoint} />
          )}
        </Field>
      ))}
      <Field>
        <FieldLabel htmlFor="service-excluded-paths">{t("serviceExcludedRoots")}</FieldLabel>
        <Textarea
          id="service-excluded-paths"
          rows={3}
          value={paths}
          disabled={busy || !status?.connected}
          onChange={(event) => {
            dirty.current = true;
            setHasChanges(true);
            setPaths(event.target.value);
          }}
        />
        <FieldDescription>{t("servicePathHelp")}</FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !status?.connected}
          onClick={() => {
            void guard.save().catch(() => {});
          }}
        >
          {t("serviceApply")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !status?.connected}
          onClick={() => {
            void manage("rebuild");
          }}
        >
          {t("serviceRebuild")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void refresh().catch((value: unknown) => setReadError(message(value)));
          }}
        >
          {t("serviceRefresh")}
        </Button>
      </div>
      {!!status?.effectiveExcludedRoots.length && (
        <details>
          <summary>{t("effectiveExclusions")}</summary>
          <pre className="whitespace-pre-wrap break-all text-xs">
            {status.effectiveExcludedRoots.join("\n")}
          </pre>
        </details>
      )}
    </section>
  );
}
function message(value: unknown): string {
  return value && typeof value === "object" && "message" in value
    ? String(value.message)
    : String(value);
}
