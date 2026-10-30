import { useTranslation } from "react-i18next";
import { HistoryIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TranslationHistoryEntry } from "./types";

export interface HistoryDrawerProps {
  className?: string;
  open: boolean;
  entries: TranslationHistoryEntry[];
  enabled: boolean;
  onToggle: () => void;
  onSelect: (entry: TranslationHistoryEntry) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}

const summary = (entry: TranslationHistoryEntry) =>
  entry.text.replace(/\s+/g, " ").trim().slice(0, 80);

const stamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};

export function HistoryDrawer({
  className,
  open,
  entries,
  enabled,
  onToggle,
  onSelect,
  onDelete,
  onClear,
  onToggleEnabled,
}: HistoryDrawerProps) {
  const { t } = useTranslation();
  if (!open)
    return (
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-9 shrink-0 flex-col items-center gap-1 rounded-lg border bg-card/60 py-2 text-muted-foreground hover:bg-muted",
          className,
        )}
        title={t("translation.historyTitle", { defaultValue: "历史" })}
        aria-label={t("translation.historyTitle", { defaultValue: "历史" })}
      >
        <HistoryIcon className="size-3.5" />
        <span className="text-[0.65rem] tabular-nums">{entries.length}</span>
      </button>
    );
  return (
    <aside
      className={cn("flex w-56 shrink-0 flex-col gap-2 border-r bg-background p-2", className)}
      aria-label={t("translation.historyTitle", { defaultValue: "历史" })}
    >
      <div className="flex items-center gap-1">
        <HistoryIcon className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">
          {t("translation.historyTitle", { defaultValue: "历史" })}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{entries.length}</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={onToggle}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length ? (
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={entry.id} className="group flex items-start gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-muted"
                  onClick={() => onSelect(entry)}
                  title={entry.text}
                >
                  <span className="w-full truncate text-xs">{summary(entry)}</span>
                  <span className="text-[0.65rem] text-muted-foreground">
                    {stamp(entry.at)} · {entry.target === "en" ? "中→英" : "英→中"}
                  </span>
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t("translation.historyDelete", { defaultValue: "删除" })}
                  onClick={() => onDelete(entry.id)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {t("translation.historyEmpty", { defaultValue: "还没有翻译记录" })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t pt-2">
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          aria-pressed={enabled}
          onClick={() => onToggleEnabled(!enabled)}
        >
          {enabled
            ? t("translation.historyOn", { defaultValue: "记录历史：开" })
            : t("translation.historyOff", { defaultValue: "记录历史：关" })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          disabled={!entries.length}
          onClick={onClear}
        >
          {t("translation.historyClear", { defaultValue: "清空历史" })}
        </Button>
        <p className="px-1 text-[0.65rem] leading-relaxed text-muted-foreground">
          {t("translation.historyStorage", {
            defaultValue: "历史保存在本机插件数据目录。",
          })}
        </p>
      </div>
    </aside>
  );
}
