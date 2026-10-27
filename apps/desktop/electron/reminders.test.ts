import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./store.js";
import {
  dueReminders,
  OVERDUE_DROP_MS,
  OVERDUE_GRACE_MS,
  Reminders,
  reminderIsOverdue,
  type ReminderNotification,
} from "./reminders.js";
import type { ReminderItem } from "../src/features/reminders/types.js";

let tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floral-reminders-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeReminders(dir: string, notes: Record<string, string> = { "note-1": "清单" }) {
  const notified: ReminderNotification[] = [];
  const changed = vi.fn();
  const reminders = new Reminders({
    file: () => path.join(dir, "reminders.json"),
    getNote: (id) => {
      if (!(id in notes)) throw new AppError("noteNotFound", "找不到该便签");
      return { id, title: notes[id] };
    },
    notify: (notification) => notified.push(notification),
    onChanged: changed,
  });
  return { reminders, notified, changed };
}

function item(overrides: Partial<ReminderItem>): ReminderItem {
  return {
    id: overrides.id ?? "r1",
    noteId: overrides.noteId ?? "note-1",
    fireAt: overrides.fireAt ?? new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("pure helpers", () => {
  it("collects and sorts due reminders", () => {
    const now = Date.now();
    const late = item({ id: "late", fireAt: new Date(now - 5000).toISOString() }),
      early = item({ id: "early", fireAt: new Date(now - 60000).toISOString() }),
      future = item({ id: "future", fireAt: new Date(now + 5000).toISOString() });
    expect(dueReminders([late, future, early], now).map((x) => x.id)).toEqual(["early", "late"]);
  });

  it("marks reminders overdue past the grace window", () => {
    const now = Date.now();
    expect(reminderIsOverdue(item({ fireAt: new Date(now - 1000).toISOString() }), now)).toBe(
      false,
    );
    expect(
      reminderIsOverdue(item({ fireAt: new Date(now - OVERDUE_GRACE_MS - 1).toISOString() }), now),
    ).toBe(true);
  });
});

describe("Reminders", () => {
  it("sets, lists, and replaces within the same scope", () => {
    const { reminders } = makeReminders(tempDir());
    const first = reminders.set({
      noteId: "note-1",
      fireAt: new Date(Date.now() + 60000).toISOString(),
    });
    const second = reminders.set({
      noteId: "note-1",
      fireAt: new Date(Date.now() + 120000).toISOString(),
    });
    expect(reminders.list()).toHaveLength(1);
    expect(reminders.list()[0].id).toBe(second.id);
    expect(first.id).not.toBe(second.id);

    const task = reminders.set({
      noteId: "note-1",
      fireAt: new Date(Date.now() + 300000).toISOString(),
      taskText: "买牛奶",
    });
    expect(reminders.list()).toHaveLength(2);
    expect(task.taskText).toBe("买牛奶");
  });

  it("rejects invalid inputs", () => {
    const { reminders } = makeReminders(tempDir());
    expect(() => reminders.set({ noteId: "note-1", fireAt: "not-a-date" })).toThrow(AppError);
    expect(() =>
      reminders.set({ noteId: "missing", fireAt: new Date(Date.now() + 60000).toISOString() }),
    ).toThrow(AppError);
    expect(() =>
      reminders.set({
        noteId: "note-1",
        fireAt: new Date(Date.now() + 60000).toISOString(),
        taskText: "  ",
      }),
    ).toThrow(AppError);
  });

  it("persists and reloads items across instances", () => {
    const dir = tempDir();
    const first = makeReminders(dir);
    first.reminders.set({ noteId: "note-1", fireAt: new Date(Date.now() + 60000).toISOString() });
    const second = makeReminders(dir);
    second.reminders.load();
    expect(second.reminders.list()).toHaveLength(1);
    expect(second.reminders.list()[0].noteId).toBe("note-1");
  });

  it("quarantines a corrupt file and starts empty", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "reminders.json"), "{ broken");
    const { reminders } = makeReminders(dir);
    expect(() => reminders.load()).not.toThrow();
    expect(reminders.list()).toHaveLength(0);
    expect(fs.readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("fires due reminders in order and removes them", () => {
    const { reminders, notified, changed } = makeReminders(tempDir());
    const now = Date.now();
    reminders.set({ noteId: "note-1", fireAt: new Date(now + 1000).toISOString(), taskText: "甲" });
    reminders.set({ noteId: "note-1", fireAt: new Date(now + 2000).toISOString() });
    reminders.tick(now + 3000);
    expect(notified.map((n) => n.item.taskText ?? "note")).toEqual(["甲", "note"]);
    expect(reminders.list()).toHaveLength(0);
    expect(changed).toHaveBeenCalled();
  });

  it("appends the overdue marker when fired late", () => {
    const { reminders, notified } = makeReminders(tempDir());
    const now = Date.now();
    reminders.set({ noteId: "note-1", fireAt: new Date(now + 1000).toISOString() });
    reminders.tick(now + OVERDUE_GRACE_MS + 5000);
    expect(notified[0].overdue).toBe(true);
    expect(notified[0].body).toContain("已过期");
  });

  it("silently drops reminders more than a day late", () => {
    const { reminders, notified } = makeReminders(tempDir());
    const now = Date.now();
    reminders.set({ noteId: "note-1", fireAt: new Date(now + 1000).toISOString() });
    reminders.tick(now + OVERDUE_DROP_MS + 2000);
    expect(notified).toHaveLength(0);
    expect(reminders.list()).toHaveLength(0);
  });

  it("cascades cleanup when the note is gone at fire time", () => {
    const dir = tempDir();
    const { reminders, notified } = makeReminders(dir, {});
    fs.writeFileSync(
      path.join(dir, "reminders.json"),
      JSON.stringify({
        version: 1,
        items: [
          item({ id: "a", fireAt: new Date(Date.now() - 1000).toISOString() }),
          item({ id: "b", fireAt: new Date(Date.now() + 3600_000).toISOString() }),
        ],
      }),
    );
    reminders.load();
    reminders.tick();
    expect(notified).toHaveLength(0);
    expect(reminders.list()).toHaveLength(0);
  });

  it("cancelForNote only touches the given note", () => {
    const { reminders, changed } = makeReminders(tempDir(), {
      "note-1": "甲",
      "note-2": "乙",
    });
    reminders.set({ noteId: "note-1", fireAt: new Date(Date.now() + 60000).toISOString() });
    const other = reminders.set({
      noteId: "note-2",
      fireAt: new Date(Date.now() + 60000).toISOString(),
    });
    reminders.cancelForNote("note-1");
    expect(reminders.list().map((x) => x.id)).toEqual([other.id]);
    expect(changed).toHaveBeenCalled();
  });
});
