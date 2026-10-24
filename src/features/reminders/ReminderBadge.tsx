import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatReminderTime } from "./ReminderPicker";
import { remainingFormat } from "./presets";
import type { ReminderItem } from "./types";

/** 列表行的 ⏰ 徽章：显示最早一条提醒的剩余时间，半分钟自刷新一次。 */
export function ReminderBadge({ item }: { item: ReminderItem }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const format = remainingFormat(item.fireAt, Date.now());
  const label =
    format.kind === "minutes"
      ? t("reminder.remaining.minutes", { count: format.value, defaultValue: "{{count}} 分" })
      : format.kind === "hours"
        ? t("reminder.remaining.hours", { count: format.value, defaultValue: "{{count}} 小时" })
        : formatReminderTime(item.fireAt);
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-ink-faint bg-paper-deep/50"
      data-note-reminder={item.taskText ?? "note"}
      title={t("reminder.hasReminder", {
        time: formatReminderTime(item.fireAt),
        defaultValue: "已设提醒：{{time}}",
      })}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8.5" r="5.2" />
        <path d="M8 6v2.6l1.8 1.2M6.2 1.6h3.6" />
      </svg>
      {label}
    </span>
  );
}
