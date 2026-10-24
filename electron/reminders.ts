import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AppError, atomicWrite, readJson } from "./store.js";
import { presetFireAt, type ReminderPresetId } from "../src/features/reminders/presets.js";
import type { ReminderItem } from "../src/features/reminders/types.js";

// 提醒归主进程所有：数据目录 reminders.json（原子写）、15s 轮询调度、
// 通知副作用通过 options.notify 注入，保持本模块不依赖 electron、可单测。
export const OVERDUE_GRACE_MS = 10 * 60 * 1000;
export const OVERDUE_DROP_MS = 24 * 60 * 60 * 1000;
export const REMINDER_TICK_MS = 15_000;
const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

export function dueReminders(items: ReminderItem[], now: number): ReminderItem[] {
  return items
    .filter((item) => Date.parse(item.fireAt) <= now)
    .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
}

export function reminderIsOverdue(item: ReminderItem, now: number): boolean {
  return now - Date.parse(item.fireAt) > OVERDUE_GRACE_MS;
}

export interface ReminderNotification {
  item: ReminderItem;
  noteTitle: string;
  body: string;
  overdue: boolean;
}

export interface RemindersOptions {
  file: () => string;
  getNote: (id: string) => { id: string; title: string };
  notify: (notification: ReminderNotification) => void;
  onChanged: () => void;
}

export class Reminders {
  private items: ReminderItem[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private options: RemindersOptions) {}

  load(): void {
    const file = this.options.file();
    if (!fs.existsSync(file)) {
      this.items = [];
      return;
    }
    try {
      const data = readJson<{ version: 1; items: unknown[] }>(file);
      if (!data || !Array.isArray(data.items)) throw new Error("invalid reminders file");
      this.items = data.items.filter(isReminderItem);
    } catch (error) {
      // 与 metadata.json 的处理一致：损坏文件备份留证，不静默覆盖。
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}.json`);
      } catch {
        /* 备份失败也继续，宁可丢提醒不可阻塞启动 */
      }
      console.error("reminders-corrupt", error);
      this.items = [];
    }
  }

  list(): ReminderItem[] {
    return [...this.items].sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
  }

  forNote(noteId: string): ReminderItem[] {
    return this.list().filter((item) => item.noteId === noteId);
  }

  set(input: { noteId: string; fireAt: string; taskText?: string }): ReminderItem {
    const fireTime = Date.parse(input.fireAt),
      now = Date.now();
    if (!Number.isFinite(fireTime) || fireTime > now + MAX_FUTURE_MS)
      throw new AppError("invalidPayload", "提醒时间不合法");
    this.options.getNote(input.noteId); // 校验便签存在，不存在抛 noteNotFound
    const taskText = input.taskText?.trim();
    if (taskText !== undefined && (!taskText || taskText.length > 500))
      throw new AppError("invalidPayload", "任务内容不合法");
    // 同一作用域（同一便签的同一条任务，或便签整体）只保留一条提醒，后设覆盖先设。
    const task = taskText ?? "";
    this.items = this.items.filter(
      (item) => !(item.noteId === input.noteId && (item.taskText ?? "") === task),
    );
    const item: ReminderItem = {
      id: randomUUID(),
      noteId: input.noteId,
      fireAt: new Date(fireTime).toISOString(),
      createdAt: new Date(now).toISOString(),
      ...(taskText ? { taskText } : {}),
    };
    this.items.push(item);
    this.persist();
    this.options.onChanged();
    return item;
  }

  setPreset(input: { noteId: string; preset: ReminderPresetId; taskText?: string }): ReminderItem {
    return this.set({
      noteId: input.noteId,
      fireAt: presetFireAt(input.preset, new Date()).toISOString(),
      taskText: input.taskText,
    });
  }

  cancel(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return;
    this.persist();
    this.options.onChanged();
  }

  cancelForNote(noteId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.noteId !== noteId);
    if (this.items.length === before) return;
    this.persist();
    this.options.onChanged();
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), REMINDER_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(now = Date.now()): void {
    const due = dueReminders(this.items, now);
    if (!due.length) return;
    let changed = false;
    for (const item of due) {
      this.items = this.items.filter((pending) => pending.id !== item.id);
      changed = true;
      if (now - Date.parse(item.fireAt) > OVERDUE_DROP_MS) continue; // 超过一天的过期提醒静默丢弃
      let noteTitle: string;
      try {
        noteTitle = this.options.getNote(item.noteId).title || "无标题便签";
      } catch {
        this.cancelForNote(item.noteId); // 便签已删除，级联清掉其余提醒
        continue;
      }
      const overdue = reminderIsOverdue(item, now);
      this.options.notify({
        item,
        noteTitle,
        body: `${item.taskText ? `任务：${item.taskText}` : "提醒时间到了"}${overdue ? "（已过期）" : ""}`,
        overdue,
      });
    }
    if (changed) {
      this.persist();
      this.options.onChanged();
    }
  }

  dispose(): void {
    this.stop();
  }

  private persist(): void {
    atomicWrite(this.options.file(), JSON.stringify({ version: 1, items: this.items }, null, 2));
  }
}

function isReminderItem(value: unknown): value is ReminderItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.noteId === "string" &&
    typeof item.fireAt === "string" &&
    Number.isFinite(Date.parse(item.fireAt)) &&
    (item.taskText === undefined || typeof item.taskText === "string")
  );
}
