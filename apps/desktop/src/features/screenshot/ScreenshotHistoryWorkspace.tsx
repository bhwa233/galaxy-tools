import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { invoke } from "../../platform/desktop";

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
  const [error, setError] = useState<string>();
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
    try {
      const list = (await invoke("screenshot_action", {
        action: "list",
      })) as unknown as HistoryEntry[];
      if (active.current) setEntries(Array.isArray(list) ? list : []);
    } catch (value) {
      if (active.current) setError(message(value));
    } finally {
      if (active.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (action: "copy" | "save" | "ocr" | "remove", id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("screenshot_action", { action, id });
      // Copying and saving leave the row untouched; deletion must not.
      if (active.current && action === "remove") await load();
    } catch (value) {
      if (active.current) setError(message(value));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("screenshot_action", { action: "clear" });
      if (active.current) setEntries([]);
    } catch (value) {
      if (active.current) setError(message(value));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
      aria-label={t("screenshot.history", { defaultValue: "截图历史" })}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("screenshot.back", { defaultValue: "返回启动器" })}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("screenshot.count", {
            defaultValue: "共 {{count}} 张，最多保留 50 张",
            count: entries.length,
          })}
        </span>
        <Button
          variant="outline"
          className="ml-auto"
          disabled={busy || !entries.length}
          onClick={() => {
            void clear();
          }}
        >
          {t("screenshot.clear", { defaultValue: "清空" })}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
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
      ) : (
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("screenshot.empty", { defaultValue: "还没有截图。截图完成后会自动记录在这里。" })}
        </p>
      )}
    </section>
  );
}
