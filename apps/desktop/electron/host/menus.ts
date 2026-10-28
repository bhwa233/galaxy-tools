import { BrowserWindow, Menu, Notification } from "electron";
import type { NoteMetadata } from "../../src/features/notes/types.js";
import { REMINDER_PRESETS } from "../../src/features/reminders/presets.js";
import { buildPluginTrayMenu } from "../host/plugin-tray.js";
import { AppError } from "../persistence.js";
import type { ReminderNotification } from "../reminders.js";
import type { RuntimeContext } from "../runtime.js";

/** menus owns this domain; shared state remains in the composition root. */
export function createMenus(
  ctx: Pick<
    RuntimeContext,
    | "notesActive"
    | "notesScope"
    | "maintenance"
    | "notesClient"
    | "ui"
    | "requestLauncher"
    | "openHostSettings"
    | "reportError"
    | "pluginHost"
    | "hostConfig"
    | "hostShutdown"
    | "activateHostCommand"
    | "openNote"
    | "quit"
    | "layouts"
    | "labelOf"
    | "emit"
    | "foldAndRelease"
    | "hideAndRelease"
    | "setNotePinned"
    | "openNoteWithAnchor"
    | "lastBalloonReminder"
    | "tray"
  >,
) {
  async function globalMenu(): Promise<Electron.Menu> {
    let notesAvailable = ctx.notesActive && ctx.notesScope?.state === "active" && !ctx.maintenance;
    let notes: NoteMetadata[] = [];
    if (notesAvailable) {
      try {
        notes = await ctx.notesClient.list();
      } catch (error) {
        // A menu requested just before prepare may reach the manager after its
        // fence. Keep host actions available and refresh again on manager change.
        notesAvailable = false;
        if (!(error instanceof AppError && error.code.startsWith("plugin")))
          console.error("tray-notes", error);
      }
    }
    return Menu.buildFromTemplate([
      { label: ctx.ui("打开启动器", "Open launcher"), click: ctx.requestLauncher },
      {
        label: ctx.ui("设置", "Settings"),
        click: () => {
          void ctx.openHostSettings({ page: "general" }).catch(ctx.reportError);
        },
      },
      { type: "separator" },
      ...buildPluginTrayMenu({
        plugins: () => ctx.pluginHost?.trayPlugins() ?? [],
        preferences: () => ctx.hostConfig.value.trayMenu,
        available: (pluginId, commandId) =>
          !!ctx.pluginHost?.manager
            .commands()
            .some((entry) => entry.pluginId === pluginId && entry.command.id === commandId),
        state: (pluginId, id) => ctx.pluginHost?.trayStates.get(pluginId, id) ?? {},
        blocked: () => ctx.maintenance || ctx.hostShutdown.isQuitting,
        activate: ctx.activateHostCommand,
        onError: ctx.reportError,
      }),
      ...(notesAvailable
        ? [
            {
              label: ctx.ui("找回便签", "Recover a note"),
              submenu: notes.length
                ? notes.map((note) => ({
                    label: (note.title || note.preview || ctx.ui("无标题便签", "Untitled note"))
                      .slice(0, 50)
                      .replace(/&/g, "&&"),
                    click: () => void ctx.openNote(note.id).catch(ctx.reportError),
                  }))
                : [{ label: ctx.ui("暂无便签", "No notes"), enabled: false }],
            },
          ]
        : []),
      { type: "separator" },
      { label: ctx.ui("退出（保存后关闭）", "Quit after saving"), click: () => void ctx.quit() },
    ]);
  }

  async function paperMenu(win: BrowserWindow): Promise<Electron.Menu> {
    const layout = ctx.layouts.get(ctx.labelOf(win))!;
    const noteReminders = layout.noteId ? await ctx.notesClient.listReminders(layout.noteId) : [];
    return Menu.buildFromTemplate([
      ...(layout.view === "tile"
        ? [
            {
              label: ctx.ui("切回便签", "Edit note"),
              click: () => ctx.emit("surface-mode-request", "pad", win),
            },
          ]
        : []),
      {
        label: ctx.ui("折叠成胶囊", "Fold into capsule"),
        click: () => void ctx.foldAndRelease(win).catch((error) => ctx.reportError(error, win)),
      },
      {
        label: ctx.ui("隐藏到托盘", "Hide to tray"),
        click: () => void ctx.hideAndRelease(win).catch((error) => ctx.reportError(error, win)),
      },
      { type: "separator" },
      ...(layout.noteId
        ? [
            {
              label: ctx.ui("设置提醒", "Set reminder"),
              submenu: REMINDER_PRESETS.map((preset) => ({
                label: ctx.ui(
                  preset.label,
                  {
                    "15m": "15 minutes",
                    "30m": "30 minutes",
                    "1h": "1 hour",
                    "3h": "3 hours",
                    "today-evening": "Today at 18:00",
                    "tomorrow-morning": "Tomorrow at 09:00",
                  }[preset.id],
                ),
                click: () => {
                  void ctx.notesClient
                    .setReminderPreset({ noteId: layout.noteId!, preset: preset.id })
                    .catch((error) => ctx.reportError(error, win));
                },
              })),
            },
            ...(noteReminders.length
              ? [
                  {
                    label: ctx.ui(
                      `取消提醒（${noteReminders.length} 条）`,
                      `Cancel ${noteReminders.length} reminders`,
                    ),
                    click: () => {
                      if (layout.noteId)
                        void ctx.notesClient
                          .cancelRemindersForNote(layout.noteId)
                          .catch((error) => ctx.reportError(error, win));
                    },
                  },
                ]
              : []),
            { type: "separator" as const },
          ]
        : []),
      {
        label: ctx.ui("置顶", "Always on top"),
        type: "checkbox",
        checked: layout.topmost,
        click: (item) => {
          if (layout.noteId)
            void ctx
              .setNotePinned(layout.noteId, item.checked)
              .catch((error) => ctx.reportError(error, win));
        },
      },
    ]);
  }

  function fireReminderNotification({ item, noteTitle, body }: ReminderNotification): void {
    const open = () => {
      void ctx
        .openNoteWithAnchor(item.noteId, item.taskText)
        .catch((error) => ctx.reportError(error));
    };
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: noteTitle,
        body,
        silent: !ctx.hostConfig.value.reminderSound,
      });
      notification.on("click", open);
      notification.show();
      return;
    }
    ctx.lastBalloonReminder = item;
    ctx.tray?.displayBalloon({ iconType: "info", title: noteTitle, content: body });
  }

  function refreshTray(): void {
    if (!ctx.tray) return;
    ctx.tray.refresh();
  }
  return { globalMenu, paperMenu, fireReminderNotification, refreshTray };
}
