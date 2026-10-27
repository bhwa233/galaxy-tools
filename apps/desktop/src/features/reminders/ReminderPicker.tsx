import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelReminder, setReminder } from "./api";
import { presetFireAt, REMINDER_PRESETS } from "./presets";
import type { ReminderItem } from "./types";

const DATETIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatReminderTime(fireAt: string): string {
  return DATETIME_FORMAT.format(new Date(fireAt));
}

export interface ReminderPickerProps {
  noteId: string;
  /** 有值为任务行级提醒 */
  taskText?: string;
  /** 该便签的现有提醒列表（含任务级），面板内部自行筛选作用域 */
  scopeItems: ReminderItem[];
  onDone: () => void;
  onError: (message: string) => void;
}

/** 预设 + 自定义分钟数的提醒设置内容，用于列表菜单与便签右上角提醒面板。 */
export function ReminderPicker({
  noteId,
  taskText,
  scopeItems,
  onDone,
  onError,
}: ReminderPickerProps) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const scoped = taskText ? scopeItems.filter((item) => item.taskText === taskText) : scopeItems;

  const run = (action: Promise<unknown>) => {
    setBusy(true);
    action
      .then(() => onDone())
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-w-[176px] select-none">
      {scoped.length > 0 && (
        <div className="border-b border-paper-deep/20 mb-1">
          {scoped.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 px-3 py-1 text-[11px] text-ink-faint"
            >
              <span className="truncate" title={item.taskText}>
                {item.taskText ? `${item.taskText} · ` : ""}
                {formatReminderTime(item.fireAt)}
              </span>
              <button
                type="button"
                data-reminder-cancel={item.id}
                disabled={busy}
                aria-label={t("reminder.cancel", { defaultValue: "取消提醒" })}
                title={t("reminder.cancel", { defaultValue: "取消提醒" })}
                onClick={() => run(cancelReminder(item.id))}
                className="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded text-ink-ghost hover:text-red-500 hover:bg-danger-bg cursor-pointer"
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      {REMINDER_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          disabled={busy}
          data-reminder-preset={preset.id}
          onClick={() =>
            run(
              setReminder({
                noteId,
                fireAt: presetFireAt(preset.id, new Date()).toISOString(),
                taskText,
              }),
            )
          }
          className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
        >
          <span>{t(`reminder.presets.${preset.id}`, { defaultValue: preset.label })}</span>
          <span className="text-[10px] text-ink-ghost shrink-0">
            {formatReminderTime(presetFireAt(preset.id, new Date()).toISOString())}
          </span>
        </button>
      ))}
      <form
        className="flex items-center gap-1.5 px-3 py-1.5 border-t border-paper-deep/20 mt-1"
        onSubmit={(event) => {
          event.preventDefault();
          const value = Number(minutes);
          if (!Number.isFinite(value) || value <= 0 || value > 525600) return;
          run(
            setReminder({
              noteId,
              fireAt: new Date(Date.now() + value * 60_000).toISOString(),
              taskText,
            }),
          );
        }}
      >
        <input
          type="number"
          min={1}
          max={525600}
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          placeholder={t("reminder.customMinutes", { defaultValue: "自定义（分钟）" })}
          className="min-w-0 flex-1 h-7 px-2 rounded bg-paper-warm/70 border border-paper-deep/40 text-[11px] text-ink-soft"
        />
        <button
          type="submit"
          disabled={busy || !minutes}
          className="h-7 px-2.5 rounded border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-50"
        >
          {t("reminder.apply", { defaultValue: "确定" })}
        </button>
      </form>
    </div>
  );
}
