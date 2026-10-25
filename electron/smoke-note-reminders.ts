import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { SmokeContext } from "./smoke.js";
import type { ReminderItem } from "../src/features/reminders/types.js";

/** Exercise header reminders through real renderer clicks, IPC and isolated saved files. */
export async function verifyNoteReminders(context: SmokeContext, main: BrowserWindow) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const bell = "[data-note-reminder-button]";
  const panel = "[data-note-reminder-panel]";
  async function until(win: BrowserWindow, expression: string, message: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript(expression).catch(() => false)) return;
      await wait(50);
    }
    throw new Error(message);
  }
  async function click(win: BrowserWindow, selector: string) {
    const point = await win.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing click target');
      const rect = element.getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
    })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await wait(80);
  }
  async function openPanel(win: BrowserWindow) {
    await click(win, bell);
    await until(win, `!!document.querySelector('${panel}')`, "Header did not open reminder panel");
    const fits = await win.webContents.executeJavaScript(`(() => {
      const r=document.querySelector('${panel}').getBoundingClientRect();
      return r.left>=3 && r.top>=3 && r.right<=innerWidth-3 && r.bottom<=innerHeight-3;
    })()`);
    if (!fits) throw new Error("Reminder panel extends outside its window");
  }
  async function list(): Promise<ReminderItem[]> {
    const result = await main.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('reminders_list')",
    );
    if (!result.ok) throw new Error("Could not list reminders");
    return result.value;
  }
  const win = context.windows.get(context.openNote())!;
  const errors: string[] = [];
  const onConsole = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    if (details.level === "error") errors.push(details.message);
  };
  win.webContents.on("console-message", onConsole);
  main.webContents.on("console-message", onConsole);
  try {
    await until(win, `!!document.querySelector('${bell}')`, "Small note has no reminder button");
    const originalCount = context.store.list().length;
    // A fresh empty draft must be saved by the reminder entry itself, without requiring Ctrl+S.
    await openPanel(win);
    const layout = [...context.layouts.values()].find(
      (entry) => context.windows.get(entry.label) === win,
    )!;
    const id = layout.noteId;
    if (!id || context.store.list().length !== originalCount + 1)
      throw new Error("Draft reminder entry did not save exactly one note");
    await click(win, '[data-reminder-preset="15m"]');
    await until(
      win,
      `document.querySelector('${bell}')?.dataset.hasReminder==='true' && !document.querySelector('${panel}')`,
      "Preset did not activate the note reminder",
    );
    const first = (await list()).filter((item) => item.noteId === id);
    if (first.length !== 1 || first[0].taskText !== undefined)
      throw new Error("Header preset created a task reminder instead of a note reminder");
    await click(win, '[data-note-editor-mode="text"]');
    await until(win, "!!document.querySelector('textarea')", "Could not switch to source editing");
    const source = "# 便签提醒\n\n- [ ] 核对提醒\n\n正文保持原样。";
    await win.webContents.executeJavaScript("document.querySelector('textarea').focus()");
    await win.webContents.insertText(source);
    await until(
      win,
      `(async () => {
      const result = await window.spark233Desktop.invoke('notes_get', {id:${JSON.stringify(id)}});
      return result.ok && result.value.content === ${JSON.stringify(source)};
    })()`,
      "Reminder note was not automatically saved",
    );
    await click(win, '[data-note-editor-mode="markdown"]');
    await until(
      win,
      "!!document.querySelector('input[type=checkbox]')",
      "Reminder note tasks did not render",
    );
    const original = context.store.get(id);
    await main.webContents.executeJavaScript(
      `window.spark233Desktop.invoke('open_note_in_editor',{noteId:${JSON.stringify(id)}})`,
    );
    await until(
      main,
      `document.querySelector('textarea')?.value===${JSON.stringify(source)} && document.querySelector('${bell}')?.dataset.hasReminder==='true'`,
      "Main header did not synchronize the small note reminder",
    );
    await openPanel(main);
    const output = path.dirname(context.output);
    fs.writeFileSync(path.join(output, "reminder-main.png"), (await main.capturePage()).toPNG());
    await click(main, '[data-reminder-preset="30m"]');
    await until(
      main,
      `!document.querySelector('${panel}')`,
      "Changing a reminder did not close its panel",
    );
    const changed = (await list()).filter((item) => item.noteId === id);
    if (changed.length !== 1 || changed[0].id === first[0].id || changed[0].taskText !== undefined)
      throw new Error("Changing reminder did not replace the note-level entry");
    if (Math.abs(Date.parse(changed[0].fireAt) - Date.now() - 30 * 60_000) > 10_000)
      throw new Error("Changed preset has the wrong time");
    await openPanel(win);
    fs.writeFileSync(path.join(output, "reminder-pad.png"), (await win.capturePage()).toPNG());
    // Native pointer events verify that a second bell click closes instead of reopening.
    await click(win, bell);
    await until(
      win,
      `!document.querySelector('${panel}')`,
      "Second bell click did not close panel",
    );
    await openPanel(win);
    await win.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    await until(
      win,
      `!document.querySelector('${panel}')`,
      "Escape did not dismiss reminder panel",
    );
    await openPanel(win);
    await win.webContents.executeJavaScript(
      "document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))",
    );
    await until(
      win,
      `!document.querySelector('${panel}')`,
      "Outside click did not dismiss reminder panel",
    );
    context.emit("surface-mode-request", "tile", win);
    await until(
      win,
      "!!document.querySelector('[data-surface-mode=tile]')",
      "Could not switch reminder note to tile",
    );
    await wait(500);
    const bounds = win.getBounds();
    await openPanel(win);
    fs.writeFileSync(path.join(output, "reminder-tile.png"), (await win.capturePage()).toPNG());
    if (JSON.stringify(win.getBounds()) !== JSON.stringify(bounds))
      throw new Error("Opening tile reminder dragged or resized the window");
    await click(win, `[data-reminder-cancel="${changed[0].id}"]`);
    await until(
      main,
      `!document.querySelector('${bell}')?.dataset.hasReminder`,
      "Cancel from tile did not synchronize main header",
    );
    if ((await list()).some((item) => item.noteId === id))
      throw new Error("Cancelled reminder remains stored");
    // Preserve and manage reminders created by the previous task-row UI.
    const legacy = await main.webContents.executeJavaScript(
      `window.spark233Desktop.invoke('reminders_set',{noteId:${JSON.stringify(id)},taskText:'核对提醒',fireAt:new Date(Date.now()+3600000).toISOString()})`,
    );
    if (!legacy.ok) throw new Error("Could not seed historical task reminder");
    await until(
      main,
      `document.querySelector('${bell}')?.dataset.hasReminder==='true'`,
      "Historical task reminder did not activate note header",
    );
    await openPanel(main);
    await until(
      main,
      `document.querySelector('${panel}')?.textContent.includes('核对提醒')`,
      "Historical task reminder not shown in note panel",
    );
    await click(main, `[data-reminder-cancel="${legacy.value.id}"]`);
    await until(
      win,
      `!document.querySelector('${bell}')?.dataset.hasReminder`,
      "Historical task cancellation did not synchronize tile",
    );
    for (const target of [main, win]) {
      if (
        await target.webContents.executeJavaScript("!!document.querySelector('.task-reminder-btn')")
      )
        throw new Error("Task-row reminder button is still present");
      if (
        !(await target.webContents.executeJavaScript(
          `(() => {const r=document.querySelector('${bell}').getBoundingClientRect();return r.top<90 && r.left>innerWidth/2;})()`,
        ))
      )
        throw new Error("Reminder entry is not at upper right");
    }
    const saved = context.store.get(id);
    if (saved.content !== original.content || saved.updatedAt !== original.updatedAt)
      throw new Error("Reminder operations modified note content or content timestamp");
    if (errors.length) throw new Error(`Reminder renderer errors: ${errors.join("; ")}`);
    await context.hideAndRelease(win);
    return {
      draftSavedOnce: true,
      autoSaveWithoutFooter: true,
      noteLevelPreset: true,
      presetReplacesReminder: true,
      mainAndPadSync: true,
      tileCancelSync: true,
      historicalTaskManaged: true,
      upperRightEntries: true,
      taskRowEntryRemoved: true,
      panelFitsWindow: true,
      bellToggles: true,
      escapeDismissal: true,
      outsideDismissal: true,
      tileClickDoesNotDrag: true,
      contentAndTimestampPreserved: true,
      rendererErrors: errors,
    };
  } finally {
    main.webContents.removeListener("console-message", onConsole);
    if (!win.isDestroyed()) win.webContents.removeListener("console-message", onConsole);
  }
}
