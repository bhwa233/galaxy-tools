import { invoke } from "../../platform/desktop";
import type { ReminderItem } from "./types";

export function listReminders(): Promise<ReminderItem[]> {
  return invoke("reminders_list");
}

export function setReminder(input: {
  noteId: string;
  fireAt: string;
  taskText?: string;
}): Promise<ReminderItem> {
  return invoke("reminders_set", input);
}

export function cancelReminder(id: string): Promise<void> {
  return invoke("reminders_cancel", { id });
}
