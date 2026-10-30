import { showToast } from "../../components/Toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { invoke, listen } from "../../platform/desktop";

interface HistoryEntry {
  id: string;
  createdAt: number;
  width: number;
  height: number;
  size: number;
  action: "copy" | "save" | "ocr";
  resource: { id: string };
}

const time = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function ScreenshotHistoryWorkspace({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const loadFailed = !!loadError;
  const displayedError = loadError;
  const loadGeneration = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const message = (value: unknown) =>
    value && typeof value === "object" && "message" in value
      ? String(value.message)
      : String(value);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const list = (await invoke("screenshot_action", {
        action: "list",
      })) as unknown as HistoryEntry[];
      if (active.current && generation === loadGeneration.current) {
        setEntries(Array.isArray(list) ? list : []);
        setLoadError(undefined);
      }
    } catch (value) {
      if (active.current && generation === loadGeneration.current) {
        setLoadError(message(value));
      }
    } finally {
      if (active.current && generation === loadGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    const subscription = listen("screenshot-result", refresh);
    window.addEventListener("focus", refresh);
    void load();
    return () => {
      loadGeneration.current++;
      window.removeEventListener("focus", refresh);
      void subscription.then((stop) => stop());
    };
  }, [load]);
  const act = async (action: "copy" | "save" | "ocr" | "remove", id: string) => {
    setBusy(true);
    try {
      const result = await invoke("screenshot_action", { action, id });
      if (active.current) {
        if (action === "copy") showToast(t("notifications.copied"), "success");
        if (
          action === "save" &&
          result &&
          typeof result === "object" &&
          "saved" in result &&
          result.saved
        )
          showToast(t("notifications.saved"), "success");
        if (action === "remove") showToast(t("notifications.deleted"), "success");
      }
      // Copying and saving leave the row untouched; deletion must not.
      if (active.current && action === "remove") await load();
    } catch (value) {
      if (active.current) showToast(message(value));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await invoke("screenshot_action", { action: "clear" });
      if (active.current) showToast(t("notifications.cleared"), "success");
      if (active.current) await load();
    } catch (value) {
      if (active.current) showToast(message(value));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
      aria-label={t("screenshot.history", { defaultValue: "截图历史" })}
    >
      <div className="electron-title-drag flex flex-wrap items-center gap-2">
        {!loadFailed && (
          <span className="text-xs text-muted-foreground">
            {t("screenshot.count", {
              defaultValue: "共 {{count}} 张，最多保留 50 张",
              count: entries.length,
            })}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          disabled={busy || loading}
          title={t("screenshot.refresh")}
          aria-label={t("screenshot.refresh")}
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          variant="outline"
          disabled={busy || !entries.length}
          onClick={() => {
            void clear();
          }}
        >
          {t("screenshot.clear", { defaultValue: "清空" })}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("screenshot.close")}
          aria-label={t("screenshot.close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {displayedError && (
        <Alert variant="destructive">
          <AlertDescription>{displayedError}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : entries.length ? (
        <ul className="grid min-h-0 flex-1 auto-rows-min gap-3 [grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))]">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-2 rounded-lg border p-2"
              data-screenshot={entry.id}
            >
              <img
                className="h-28 w-full rounded bg-muted object-contain"
                src={`spark233://resource/${encodeURIComponent(entry.resource.id)}`}
                alt={time.format(entry.createdAt)}
                loading="lazy"
                draggable={false}
              />
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{time.format(entry.createdAt)}</span>
                <span>
                  {entry.width} × {entry.height} · {size(entry.size)}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void act("copy", entry.id);
                  }}
                >
                  {t("screenshot.copy", { defaultValue: "复制" })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void act("save", entry.id);
                  }}
                >
                  {t("screenshot.save", { defaultValue: "保存" })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void act("ocr", entry.id);
                  }}
                >
                  {t("screenshot.ocr", { defaultValue: "取字" })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => {
                    void act("remove", entry.id);
                  }}
                >
                  {t("screenshot.remove", { defaultValue: "删除" })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : !loadFailed ? (
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("screenshot.empty", { defaultValue: "还没有截图。截图完成后会自动记录在这里。" })}
        </p>
      ) : null}
    </section>
  );
}
