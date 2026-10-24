import { useEffect, useState } from "react";
import { listen } from "../../platform/desktop";
import { listReminders } from "./api";
import { REMINDERS_CHANGED, type ReminderItem } from "./types";

/** 全量快照订阅：主进程每次增删都会广播完整列表，直接整组替换。 */
export function useReminders(): ReminderItem[] {
  const [items, setItems] = useState<ReminderItem[]>([]);
  useEffect(() => {
    let disposed = false;
    void listReminders()
      .then((list) => {
        if (!disposed) setItems(list);
      })
      .catch(console.error);
    const unlisten = listen<ReminderItem[]>(REMINDERS_CHANGED, (event) =>
      setItems(event.payload ?? []),
    );
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);
  return items;
}
