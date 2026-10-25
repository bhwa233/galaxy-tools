import type { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { SmokeContext } from "./smoke.js";
import type { Note } from "../src/features/notes/types.js";

/** Real renderer/filesystem regression: the list and desktop edit one identity, not copies. */
export async function verifyUnifiedNoteList(
  context: SmokeContext,
  main: BrowserWindow,
  note: Note,
) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(test: () => boolean | Promise<boolean>, message: string) {
    for (let i = 0; i < 80; i++) {
      if (await test()) return;
      await wait(50);
    }
    throw new Error(message);
  }
  const selector = `[data-note-id="${note.id}"]`;
  context.emit("notes-changed");
  await until(
    () =>
      main.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`),
    "New desktop note missing from unified list",
  );
  const count = context.store.list().length;
  async function fromMenu() {
    await main.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:200}))`,
    );
    await until(
      () =>
        main.webContents.executeJavaScript(
          "!!document.querySelector('[data-note-action=desktop]')",
        ),
      "Desktop action missing from list context menu",
    );
    await main.webContents.executeJavaScript(
      "document.querySelector('[data-note-action=desktop]').click()",
    );
  }
  await ensureSourceEditor(main);
  const originalModifiedAt = context.store.get(note.id).updatedAt;
  await main.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).querySelector('[data-note-pin]').click()`,
  );
  await until(
    () =>
      main.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).querySelector('[data-note-pin]')?.getAttribute('aria-pressed')==='true'`,
      ),
    "List pin did not update",
  );
  // Existing fixture categories legitimately precede the uncategorized group.
  // Check pin ordering among this note's peers, without imposing global order.
  const peerIds = context.store
    .list()
    .filter((item) => item.category === note.category)
    .map((item) => item.id);
  await until(
    async () =>
      (await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-note-id]')).find(node => ${JSON.stringify(peerIds)}.includes(node.getAttribute('data-note-id')))?.getAttribute('data-note-id')`,
      )) === note.id,
    "Pinned note did not move ahead of older pinned entries in its category",
  );
  const preset = [...context.layouts].find(([, e]) => e.noteId === note.id);
  if (
    !preset ||
    context.windows.has(preset[0]) ||
    context.store.get(note.id).updatedAt !== originalModifiedAt
  )
    throw new Error("List pin opened a window or changed note content time");
  await expectNotePresence(main, note.id, "unopened");
  await fromMenu();
  let label = "";
  await until(() => {
    label = [...context.layouts].find(([, e]) => e.noteId === note.id)?.[0] ?? "";
    return !!label && context.windows.has(label);
  }, "Context menu did not open its target");
  const win = context.windows.get(label)!;
  await until(
    () =>
      win.webContents
        .executeJavaScript("!!document.querySelector('[data-editor-mode]')")
        .catch(() => false),
    "Desktop editor did not hydrate",
  );
  await ensureSourceEditor(win);
  await until(
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('textarea').value===${JSON.stringify(note.content)}`,
      ),
    "Wrong note opened from list",
  );
  await expectNotePresence(main, note.id, "desktop");
  const fullscreenSuppressed = () => {
    const b = win.getBounds();
    return context
      .fullscreenRects()
      .some(
        (r) =>
          b.x < r.x + r.width &&
          b.x + b.width > r.x &&
          b.y < r.y + r.height &&
          b.y + b.height > r.y,
      );
  };
  // Fullscreen avoidance temporarily lowers the native window without changing its pin preference.
  await until(
    () => win.isAlwaysOnTop() === !fullscreenSuppressed(),
    "Opening a pinned preference did not apply the expected native window level",
  ).catch((error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; native pin diagnostic: ${JSON.stringify(
        {
          actual: win.isAlwaysOnTop(),
          expected: !fullscreenSuppressed(),
          layout: context.layouts.get(label),
          bounds: win.getBounds(),
          fullscreenRects: context.fullscreenRects(),
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          focused: win.isFocused(),
        },
      )}`,
      { cause: error },
    );
  });
  const fullscreenAvoidanceObserved = fullscreenSuppressed();
  await until(
    () =>
      win.webContents.executeJavaScript(
        "document.querySelector('[data-note-pin-paper]')?.getAttribute('aria-pressed')==='true'",
      ),
    "Paper did not receive initial pin state",
  );
  await win.webContents.executeJavaScript(
    "document.querySelector('[data-note-pin-paper]').click()",
  );
  await until(
    () =>
      main.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).querySelector('[data-note-pin]')?.getAttribute('aria-pressed')==='false'`,
      ),
    "Paper unpin did not update list",
  );
  if (win.isAlwaysOnTop()) throw new Error("Paper unpin left native topmost enabled");
  await main.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).querySelector('[data-note-pin]').click()`,
  );
  await until(
    () =>
      win.webContents.executeJavaScript(
        "document.querySelector('[data-note-pin-paper]')?.getAttribute('aria-pressed')==='true'",
      ),
    "List pin did not update paper",
  );
  const persisted = JSON.parse(
    fs.readFileSync(path.join(context.store.dataDir, "electron-layout.json"), "utf8"),
  );
  if (
    !persisted.windows.some(
      (e: { noteId?: string; topmost?: boolean }) => e.noteId === note.id && e.topmost,
    )
  )
    throw new Error("Pin preference was not persisted");
  await wait(200);
  await fromMenu();
  await wait(220);
  if (context.store.list().length !== count || context.windows.get(label) !== win)
    throw new Error("Desktop action duplicated a note or window");
  await main.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
  const value = (w: BrowserWindow) =>
    w.webContents.executeJavaScript("document.querySelector('textarea')?.value");
  await until(async () => (await value(main)) === note.content, "List editor selected wrong note");
  async function type(w: BrowserWindow, text: string) {
    await w.webContents.executeJavaScript(
      `(()=>{const a=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(a,${JSON.stringify(text)});a.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  }
  async function save(w: BrowserWindow, text: string) {
    await w.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))",
    );
    await until(
      () => context.store.get(note.id).content === text,
      "Editor save did not reach shared Markdown file",
    );
  }
  const listText = "列表保存：同一张便签 **同步**\n";
  await type(main, listText);
  await save(main, listText);
  await until(
    async () => (await value(win)) === listText,
    "List save did not update clean desktop",
  );
  const desktopText = "桌面保存：回到同一个便签列表\n";
  await type(win, desktopText);
  await save(win, desktopText);
  await until(
    async () => (await value(main)) === desktopText,
    "Desktop save did not update list editor",
  );
  const pendingText = "桌面尚未保存的输入必须保留\n";
  await type(win, pendingText);
  const otherText = "列表保存时不得覆盖桌面的未保存输入\n";
  await type(main, otherText);
  await save(main, otherText);
  await wait(200);
  if ((await value(win)) !== pendingText)
    throw new Error("List refresh overwrote unsaved desktop input");
  await type(win, note.content);
  await save(win, note.content);
  await until(async () => (await value(main)) === note.content, "Final shared note did not settle");
  return {
    label,
    win,
    checks: {
      contextMenuTarget: true,
      pinWithoutOpening: true,
      pinnedOrderInList: true,
      nativePinOnOpen: true,
      fullscreenAvoidanceObserved,
      pinListToPaper: true,
      pinPaperToList: true,
      pinPersisted: true,
      reusesWindow: true,
      noCopy: true,
      listToDesktop: true,
      desktopToList: true,
      dirtyInputPreserved: true,
    },
  };
}

export async function expectNotePresence(
  main: BrowserWindow,
  noteId: string,
  presence: string,
): Promise<void> {
  const selector = `[data-note-id="${noteId}"] [data-note-presence="${presence}"]`;
  for (let i = 0; i < 80; i++) {
    if (
      await main.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`List state did not become ${presence} for ${noteId}`);
}

/** New notes default to Markdown preview; source editing is an explicit per-note choice. */
export async function ensureSourceEditor(win: BrowserWindow): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await win.webContents
      .executeJavaScript(`(() => {
      const expectedId = new URLSearchParams(location.search).get('noteId');
      const pad = document.querySelector('[data-surface-mode=pad]');
      if (expectedId && pad && pad.getAttribute('data-note-id') !== expectedId) return false;
      const toggle = document.querySelector('[data-note-editor-mode="text"]');
      if (toggle && toggle.getAttribute('aria-pressed') !== 'true') {
        toggle.click();
        return false;
      }
      return !!document.querySelector('textarea');
    })()`)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Source editor did not become ready");
}
