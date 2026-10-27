export type ReminderPresetId = "15m" | "30m" | "1h" | "3h" | "today-evening" | "tomorrow-morning";

export const REMINDER_PRESETS: Array<{ id: ReminderPresetId; label: string }> = [
  { id: "15m", label: "15 分钟" },
  { id: "30m", label: "30 分钟" },
  { id: "1h", label: "1 小时" },
  { id: "3h", label: "3 小时" },
  { id: "today-evening", label: "今天 18:00" },
  { id: "tomorrow-morning", label: "明天 9:00" },
];

const MINUTE = 60_000;

export function presetFireAt(id: ReminderPresetId, now: Date): Date {
  const at = new Date(now.getTime());
  switch (id) {
    case "15m":
      return new Date(at.getTime() + 15 * MINUTE);
    case "30m":
      return new Date(at.getTime() + 30 * MINUTE);
    case "1h":
      return new Date(at.getTime() + 60 * MINUTE);
    case "3h":
      return new Date(at.getTime() + 180 * MINUTE);
    case "today-evening":
      at.setHours(18, 0, 0, 0);
      if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
      return at;
    case "tomorrow-morning":
      at.setDate(at.getDate() + 1);
      at.setHours(9, 0, 0, 0);
      return at;
  }
}

export type RemainingFormat =
  | { kind: "minutes"; value: number; date: Date }
  | { kind: "hours"; value: number; date: Date }
  | { kind: "datetime"; value: 0; date: Date };

export function remainingFormat(fireAt: string, now: number): RemainingFormat {
  const target = Date.parse(fireAt);
  const diff = Math.max(0, target - now);
  if (diff < 60 * MINUTE)
    return {
      kind: "minutes",
      value: Math.max(1, Math.round(diff / MINUTE)),
      date: new Date(target),
    };
  if (diff < 48 * 60 * MINUTE)
    return { kind: "hours", value: Math.round(diff / (60 * MINUTE)), date: new Date(target) };
  return { kind: "datetime", value: 0, date: new Date(target) };
}
