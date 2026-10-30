import { showToast } from "../../components/Toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ManagementSurface";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SlidingButtonGroup } from "@/components/SlidingButtonGroup";
import {
  clearDiagnostics,
  exportDiagnostics,
  listDiagnostics,
  subscribeDiagnostics,
  unsubscribeDiagnostics,
  watchDiagnostics,
} from "./api";
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_ERROR_CODES,
  DIAGNOSTIC_KINDS,
  DIAGNOSTIC_LEVELS,
  type DiagnosticBatch,
  type DiagnosticFilter,
  type DiagnosticLevel,
  type DiagnosticSnapshot,
} from "./types";

interface DiagnosticsDialogProps {
  embedded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A document owns one host subscription. Keep its lifecycle queue across
// SettingsPanel unmount/remount, so an old close cannot unsubscribe a new view.
let subscriptionTail: Promise<void> = Promise.resolve();

export function DiagnosticsDialog({
  open,
  onOpenChange,
  embedded = false,
}: DiagnosticsDialogProps) {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot>();
  const current = useRef<DiagnosticSnapshot | undefined>(undefined);
  const cursor = useRef(0);
  const retiredEpochs = useRef(new Set<string>());
  const clearingEpoch = useRef<string | undefined>(undefined);
  const connection = useRef(0);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"clear" | "export" | "refresh">();
  const operation = useRef(false);
  const [error, setError] = useState<"unavailable" | "failed">();
  const [notice, setNotice] = useState<"memoryClearedDiskUnavailable">();
  const [source, setSource] = useState<"all" | "host" | "plugin">("all");
  const [pluginId, setPluginId] = useState("");
  const [levels, setLevels] = useState<DiagnosticLevel[]>([...DIAGNOSTIC_LEVELS]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const reportFailure = (value: unknown) => {
    const unavailable =
      value &&
      typeof value === "object" &&
      "code" in value &&
      value.code === "diagnosticsUnavailable";
    setError(unavailable ? "unavailable" : "failed");
  };

  // Batch.lastSequence describes the whole store; only cursor and received
  // entries acknowledge this subscriber's first 100-item batch.
  const merge = useCallback((incoming: DiagnosticSnapshot, batchCursor?: number) => {
    if (retiredEpochs.current.has(incoming.epoch)) return;
    const previous = current.current;
    const sameEpoch = previous?.epoch === incoming.epoch;
    if (previous && !sameEpoch) retiredEpochs.current.add(previous.epoch);
    if (!sameEpoch) cursor.current = 0;
    const entries = new Map(
      (sameEpoch ? previous.entries : []).map((entry) => [entry.sequence, entry]),
    );
    for (const entry of incoming.entries) entries.set(entry.sequence, entry);
    const firstSequence = Math.max(sameEpoch ? previous.firstSequence : 0, incoming.firstSequence);
    const limit = Math.max(1, Math.min(1000, incoming.limits.historyEntries));
    const ordered = [...entries.values()]
      .filter((entry) => entry.sequence >= firstSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-limit);
    const receivedCursor = batchCursor ?? incoming.entries.at(-1)?.sequence ?? 0;
    cursor.current = Math.max(cursor.current, receivedCursor);
    const metadata =
      sameEpoch && previous.lastSequence > incoming.lastSequence ? previous : incoming;
    // Drop counters and disk failures only reset with the store epoch. A late
    // list response with the same sequence must not hide a newer warning.
    const dropped = { ...incoming.dropped };
    if (sameEpoch) {
      for (const key of Object.keys(dropped) as Array<keyof typeof dropped>) {
        dropped[key] = Math.max(dropped[key], previous.dropped[key]);
      }
    }
    const next: DiagnosticSnapshot = {
      ...metadata,
      epoch: incoming.epoch,
      firstSequence,
      lastSequence: Math.max(sameEpoch ? previous.lastSequence : 0, incoming.lastSequence),
      entries: ordered,
      dropped,
      diskStatus:
        sameEpoch && previous.diskStatus === "unavailable" ? "unavailable" : incoming.diskStatus,
    };
    current.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    const generation = ++connection.current;
    let closed = false;
    let stop: (() => void) | undefined;
    let subscribed = false;
    current.current = undefined;
    cursor.current = 0;
    clearingEpoch.current = undefined;
    setSnapshot(undefined);
    setError(undefined);
    setNotice(undefined);
    setLoading(true);
    // Serialize document subscription lifecycle, including close/reopen while
    // subscribe is pending: an old unsubscribe cannot remove a newer listener.
    subscriptionTail = subscriptionTail
      .catch(() => {})
      .then(async () => {
        try {
          stop = await watchDiagnostics((batch: DiagnosticBatch) => {
            if (
              closed ||
              generation !== connection.current ||
              clearingEpoch.current === batch.epoch
            )
              return;
            merge(batch, batch.cursor);
          });
          if (closed) {
            stop();
            return;
          }
          subscribed = true;
          const initial = await subscribeDiagnostics();
          if (!closed && generation === connection.current) merge(initial);
        } catch (value) {
          if (!closed && generation === connection.current) reportFailure(value);
        } finally {
          if (!closed && generation === connection.current) setLoading(false);
        }
      });
    return () => {
      closed = true;
      connection.current++;
      subscriptionTail = subscriptionTail
        .catch(() => {})
        .then(async () => {
          try {
            if (subscribed) await unsubscribeDiagnostics();
          } catch {
            /* The document may already have retired; always release its listener. */
          } finally {
            stop?.();
          }
        });
    };
  }, [open, retry, merge]);

  const filterInvalid =
    (!!pluginId.trim() && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(pluginId.trim())) ||
    (!!from && !Number.isFinite(new Date(from).getTime())) ||
    (!!to && !Number.isFinite(new Date(to).getTime())) ||
    (!!from && !!to && new Date(from).getTime() > new Date(to).getTime());
  const filter = useMemo<DiagnosticFilter>(
    () => ({
      ...(source === "all" ? {} : { source }),
      ...(pluginId.trim() ? { pluginId: pluginId.trim() } : {}),
      levels,
      ...(from ? { from: new Date(from).getTime() } : {}),
      ...(to ? { to: new Date(to).getTime() } : {}),
    }),
    [source, pluginId, levels, from, to],
  );
  const entries = useMemo(
    () =>
      filterInvalid
        ? []
        : (snapshot?.entries ?? [])
            .filter(
              (entry) =>
                (!filter.source || entry.source === filter.source) &&
                (!filter.pluginId ||
                  (entry.owner?.pluginId ?? entry.target?.pluginId) === filter.pluginId) &&
                (!filter.levels || filter.levels.includes(entry.level)) &&
                (filter.from === undefined || entry.at >= filter.from) &&
                (filter.to === undefined || entry.at <= filter.to),
            )
            .reverse(),
    [snapshot, filter, filterInvalid],
  );

  const run = async (action: "clear" | "export" | "refresh") => {
    if (operation.current) return;
    operation.current = true;
    const generation = connection.current;
    setBusy(action);
    setError(undefined);
    setNotice(undefined);
    if (action === "clear") clearingEpoch.current = current.current?.epoch;
    try {
      if (action === "export") {
        const result = await exportDiagnostics(filter);
        if (generation === connection.current && result.exported)
          showToast(t("notifications.exported"), "success");
      } else {
        const result = await (action === "clear" ? clearDiagnostics() : listDiagnostics());
        if (generation === connection.current) {
          merge(result);
          if (action === "clear") {
            if (result.diskStatus === "ready") showToast(t("notifications.cleared"), "success");
            else setNotice("memoryClearedDiskUnavailable");
          } else showToast(t("notifications.refreshed"), "success");
        }
      }
    } catch (value) {
      if (generation === connection.current) {
        reportFailure(value);
        // If clear itself was rejected, recover any old-epoch entries suppressed
        // during that request from a fresh bounded authoritative snapshot.
        if (action === "clear") {
          try {
            const fresh = await listDiagnostics();
            if (generation === connection.current) merge(fresh);
          } catch {
            /* Keep the fixed operation error; never display raw exceptions. */
          }
        }
      }
    } finally {
      if (generation === connection.current) clearingEpoch.current = undefined;
      operation.current = false;
      setBusy(undefined);
    }
  };

  return (
    <Dialog embedded={embedded} open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88dvh] min-w-0 flex-col sm:max-w-4xl">
        <DialogHeader className="shrink-0 pr-7">
          <DialogTitle>{t("diagnostics.title")}</DialogTitle>
          <DialogDescription>{t("diagnostics.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-1 *:shrink-0">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t(`diagnostics.error.${error}`)}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>{t("diagnostics.error.hint")}</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || !!busy}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {t("diagnostics.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {snapshot && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("diagnostics.retention", {
                  count: Math.min(1000, snapshot.limits.historyEntries),
                })}
              </p>
              <Alert variant={snapshot.diskStatus === "unavailable" ? "destructive" : "default"}>
                <AlertTitle>{t(`diagnostics.disk.${snapshot.diskStatus}`)}</AlertTitle>
                <AlertDescription>
                  {t(`diagnostics.disk.${snapshot.diskStatus}Hint`)}
                </AlertDescription>
              </Alert>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("diagnostics.dropped.title")}</summary>
                <dl className="mt-2 grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2">
                  {(Object.keys(snapshot.dropped) as Array<keyof typeof snapshot.dropped>).map(
                    (key) => (
                      <div className="flex flex-wrap justify-between gap-x-2" key={key}>
                        <dt>{t(`diagnostics.dropped.${key}`)}</dt>
                        <dd>{snapshot.dropped[key].toLocaleString(i18n.resolvedLanguage)}</dd>
                      </div>
                    ),
                  )}
                </dl>
              </details>
            </>
          )}
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel>{t("diagnostics.filters.source")}</FieldLabel>
              <div role="group" aria-label={t("diagnostics.filters.source")}>
                <SlidingButtonGroup
                  options={[
                    { value: "all", label: t("diagnostics.source.all") },
                    { value: "host", label: t("diagnostics.source.host") },
                    { value: "plugin", label: t("diagnostics.source.plugin") },
                  ]}
                  value={source}
                  onChange={setSource}
                />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="diagnostics-plugin">
                {t("diagnostics.filters.plugin")}
              </FieldLabel>
              <Input
                id="diagnostics-plugin"
                autoComplete="off"
                placeholder="spark233.notes"
                maxLength={80}
                value={pluginId}
                onChange={(event) => setPluginId(event.target.value)}
              />
            </Field>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
              <legend className="mb-2 text-sm font-medium">{t("diagnostics.filters.level")}</legend>
              {DIAGNOSTIC_LEVELS.map((level) => (
                <Field key={level} orientation="horizontal" className="w-auto">
                  <Checkbox
                    id={`diagnostics-level-${level}`}
                    checked={levels.includes(level)}
                    onCheckedChange={(checked) =>
                      setLevels((current) =>
                        checked === true
                          ? [...current, level]
                          : current.filter((value) => value !== level),
                      )
                    }
                  />
                  <FieldLabel htmlFor={`diagnostics-level-${level}`}>
                    {t(`diagnostics.level.${level}`)}
                  </FieldLabel>
                </Field>
              ))}
            </fieldset>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="diagnostics-from">{t("diagnostics.filters.from")}</FieldLabel>
                <Input
                  id="diagnostics-from"
                  type="datetime-local"
                  step="1"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="diagnostics-to">{t("diagnostics.filters.to")}</FieldLabel>
                <Input
                  id="diagnostics-to"
                  type="datetime-local"
                  step="1"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
          {filterInvalid && (
            <p role="alert" className="text-sm text-destructive">
              {t("diagnostics.filters.invalid")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !!busy || !snapshot}
              onClick={() => {
                void run("refresh");
              }}
            >
              {t("diagnostics.refresh")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !!busy || !snapshot}
              onClick={() => {
                setSource("all");
                setPluginId("");
                setLevels([...DIAGNOSTIC_LEVELS]);
                setFrom("");
                setTo("");
              }}
            >
              {t("diagnostics.filters.reset")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !!busy || !snapshot || filterInvalid}
              onClick={() => {
                void run("export");
              }}
            >
              {t("diagnostics.export")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !!busy || !snapshot}
              onClick={() => {
                void run("clear");
              }}
            >
              {t("diagnostics.clear")}
            </Button>
          </div>
          <p
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            {(loading || busy) && <Spinner />}
            {loading
              ? t("diagnostics.loading")
              : busy
                ? t(`diagnostics.working.${busy}`)
                : notice
                  ? t(`diagnostics.notice.${notice}`)
                  : snapshot && cursor.current < snapshot.lastSequence
                    ? t("diagnostics.catchingUp", { count: entries.length })
                    : t("diagnostics.entryCount", { count: entries.length })}
          </p>
          {!loading && snapshot && entries.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("diagnostics.empty.title")}</EmptyTitle>
                <EmptyDescription>{t("diagnostics.empty.description")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <ul
            className="flex min-w-0 flex-col divide-y rounded-md border"
            aria-label={t("diagnostics.entries")}
            aria-live="off"
          >
            {entries.map((entry) => {
              const target = entry.owner ?? entry.target;
              const time = new Date(entry.at);
              const validTime = Number.isFinite(time.getTime());
              return (
                <li
                  key={`${entry.epoch}:${entry.sequence}`}
                  className="flex min-w-0 flex-col gap-2 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={entry.level === "error" ? "destructive" : "outline"}>
                      {t(
                        `diagnostics.level.${DIAGNOSTIC_LEVELS.includes(entry.level) ? entry.level : "unknown"}`,
                      )}
                    </Badge>
                    <span className="text-sm font-medium">
                      {t(
                        `diagnostics.kind.${DIAGNOSTIC_KINDS.includes(entry.kind) ? entry.kind : "unknown"}`,
                      )}{" "}
                      ·{" "}
                      {t(
                        `diagnostics.code.${DIAGNOSTIC_CODES.includes(entry.code) ? entry.code : "unknown"}`,
                      )}
                    </span>
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={validTime ? time.toISOString() : undefined}
                    >
                      {validTime
                        ? time.toLocaleString(i18n.resolvedLanguage)
                        : t("diagnostics.unknownTime")}
                    </time>
                  </div>
                  <p className="break-all text-xs text-muted-foreground">
                    {t(`diagnostics.source.${entry.source}`)}
                    {target && ` · ${target.pluginId} · ${target.version}`}
                  </p>
                  {entry.errorCode && (
                    <p className="text-sm">
                      {t(
                        `diagnostics.failure.${DIAGNOSTIC_ERROR_CODES.includes(entry.errorCode) ? entry.errorCode : "unknownFailure"}`,
                      )}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {entry.durationMs !== undefined && (
                      <span>
                        {t("diagnostics.duration", {
                          value: entry.durationMs.toLocaleString(i18n.resolvedLanguage),
                        })}
                      </span>
                    )}
                    {entry.byteCount !== undefined && (
                      <span>
                        {t("diagnostics.bytes", {
                          value: entry.byteCount.toLocaleString(i18n.resolvedLanguage),
                        })}
                      </span>
                    )}
                    {entry.count !== undefined && (
                      <span>
                        {t("diagnostics.count", {
                          value: entry.count.toLocaleString(i18n.resolvedLanguage),
                        })}
                      </span>
                    )}
                    {entry.stream && <span>{t(`diagnostics.stream.${entry.stream}`)}</span>}
                  </div>
                  {(entry.owner || entry.taskId) && (
                    <details className="break-all text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{t("diagnostics.identity")}</summary>
                      <dl className="mt-2 flex flex-col gap-1">
                        {entry.owner && (
                          <div>
                            <dt>{t("diagnostics.instance")}</dt>
                            <dd>{entry.owner.instanceId}</dd>
                          </div>
                        )}
                        {entry.taskId && (
                          <div>
                            <dt>{t("diagnostics.task")}</dt>
                            <dd>{entry.taskId}</dd>
                          </div>
                        )}
                      </dl>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
