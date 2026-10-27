export interface ReminderItem {
  id: string;
  noteId: string;
  /** ISO 时间戳 */
  fireAt: string;
  createdAt: string;
  /** 有值为任务行级提醒，锚点为任务行文本 */
  taskText?: string;
}

export const REMINDERS_CHANGED = "reminders-changed";
