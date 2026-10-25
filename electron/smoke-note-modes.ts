import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { SmokeContext } from "./smoke.js";

/** Validate source editing and read-only Markdown against the real renderer and saved files. */
export async function verifyNoteModes(context: SmokeContext, main: BrowserWindow) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(win: BrowserWindow, expression: string, message: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript(expression).catch(() => false)) return;
      await wait(50);
    }
    throw new Error(message);
  }
  const mode = (value: string) => `!!document.querySelector('[data-editor-mode="${value}"]')`;
  // Preview images load lazily; scroll the actual image into view before checking its decode.
  const screenshotReady = `(() => {
    const image = document.querySelector('[data-pad-markdown] img');
    image?.scrollIntoView({ block: 'center' });
    return image?.naturalWidth === 640;
  })()`;
  async function switchMode(win: BrowserWindow, value: string) {
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-note-editor-mode="${value}"]').click()`,
    );
    await until(win, mode(value), `Note did not switch to ${value}`);
  }
  async function save(win: BrowserWindow) {
    await win.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))",
    );
    await wait(200);
  }
  const win = context.windows.get(context.openNote())!;
  await until(win, mode("text"), "New note did not default to Text mode");
  if (
    await win.webContents.executeJavaScript(
      "!document.querySelector('textarea') || !!document.querySelector('[contenteditable=true]')",
    )
  )
    throw new Error("Default Text mode did not show the source editor");
  const headerTitle = await win.webContents.executeJavaScript(`(() => {
    const title = document.querySelector('[data-note-title]');
    const rect = title?.getBoundingClientRect();
    return !!rect && rect.top < 50 && rect.left < innerWidth / 2 && title.maxLength === 12;
  })()`);
  if (!headerTitle) throw new Error("Note title is not limited to 12 characters at upper left");
  await win.webContents.executeJavaScript("document.querySelector('[data-note-title]').focus()");
  await win.webContents.insertText("一二三四五六七八九十甲乙丙");
  if (
    (await win.webContents.executeJavaScript(
      "document.querySelector('[data-note-title]').value",
    )) !== "一二三四五六七八九十甲乙"
  )
    throw new Error("Native title input did not enforce the 12-character limit");
  const source =
    "# 原来的便签\n\n正文 **保持原样**。\n\n- [ ] 核对图片\n- [x] 已完成\n\n| 列一 | 列二 |\n| --- | --- |\n| 原文 | 保留 |\n\n公式：$E=mc^2$\n\n";
  await win.webContents.executeJavaScript("document.querySelector('textarea').focus()");
  await win.webContents.insertText(source);
  await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 240;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#edf4ed'; paint.fillRect(0,0,640,240);
    paint.fillStyle = '#32664c'; paint.font = 'bold 42px sans-serif'; paint.fillText('Markdown 图片预览',40,100);
    paint.font = '24px sans-serif'; paint.fillText('文本编辑 · MD 查看',40,155);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const data = new DataTransfer(); data.items.add(new File([blob], 'screenshot.png', {type:'image/png'}));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  })()`);
  await until(
    win,
    "/!\\[\\]\\(images\\//.test(document.querySelector('textarea')?.value ?? '')",
    "Pasting a screenshot did not insert a local Markdown image",
  );
  // Keep the existing image width extension and verify that mode changes do not reserialize it.
  await win.webContents.executeJavaScript(String.raw`(() => {
    const area = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      area, area.value.replace(/(!\[\]\(images\/[^)]+\))/, '$1{width=75%}')
    );
    area.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await save(win);
  const layout = [...context.layouts.values()].find(
    (entry) => context.windows.get(entry.label) === win,
  )!;
  const id = layout.noteId;
  if (!id) throw new Error("Screenshot paste did not save its note");
  if (context.store.get(id).title !== "一二三四五六七八九十甲乙")
    throw new Error("Header title did not save with the note");
  const original = context.store.get(id).content;
  if (
    !original.startsWith(source) ||
    !original.includes("{width=75%}") ||
    original.includes("spark233://")
  )
    throw new Error("Source or relative image reference was changed while saving");
  await switchMode(win, "markdown");
  await until(win, screenshotReady, "Markdown mode did not display the local screenshot");
  await until(
    win,
    "document.querySelectorAll('[data-pad-markdown] input[type=checkbox]').length === 2",
    "Markdown preview did not render tasks",
  );
  if (
    await win.webContents.executeJavaScript(
      "!!document.querySelector('textarea,[contenteditable=true]')",
    )
  )
    throw new Error("Markdown mode did not remain read-only");
  await save(win);
  if (context.store.get(id).content !== original)
    throw new Error("Switching to Markdown rewrote the source");
  await win.webContents.executeJavaScript(
    "document.querySelector('[data-pad-markdown] input[type=checkbox]').click()",
  );
  await save(win);
  const checked = original.replace("- [ ] 核对图片", "- [x] 核对图片");
  if (context.store.get(id).content !== checked)
    throw new Error("Checking a task altered unrelated Markdown");
  const output = path.dirname(context.output);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "note-pad-md.png"), (await win.capturePage()).toPNG());
  await switchMode(win, "text");
  await until(
    win,
    `document.querySelector('textarea')?.value === ${JSON.stringify(checked)}`,
    "Text mode did not show the exact saved source",
  );
  fs.writeFileSync(path.join(output, "note-pad-text.png"), (await win.capturePage()).toPNG());
  await context.foldAndRelease(win);
  const reopened = context.windows.get(context.openNote(id))!;
  await until(reopened, mode("text"), "Fold/reopen forgot the note's Text mode");
  await switchMode(reopened, "markdown");
  await until(reopened, screenshotReady, "Reopening lost the image preview");
  if (context.store.get(id).content !== checked) throw new Error("Fold/reopen altered the source");
  await main.webContents.executeJavaScript(
    `window.spark233Desktop.invoke('open_note_in_editor',{noteId:${JSON.stringify(id)}})`,
  );
  await until(
    main,
    `document.querySelector('textarea')?.value === ${JSON.stringify(checked)}`,
    "Main editor did not load the same source",
  );
  await main.webContents.executeJavaScript(
    "document.querySelector('button[data-value=edit]').click()",
  );
  await until(
    main,
    "!!document.querySelector('textarea') && !document.querySelector('.markdown-selectable')",
    "Main Edit mode is not source-only",
  );
  if (
    await main.webContents.executeJavaScript(
      "!!document.querySelector('button[data-value=preview]')",
    )
  )
    throw new Error("Main window unexpectedly offers a third preview mode");
  await main.webContents.executeJavaScript(
    "document.querySelector('button[data-value=split]').click()",
  );
  await until(
    main,
    "document.querySelector('.markdown-selectable img')?.naturalWidth === 640",
    "Main split preview did not render the image",
  );
  await main.webContents.executeJavaScript(
    "document.querySelector('.markdown-selectable input[type=checkbox]').click()",
  );
  await save(main);
  if (context.store.get(id).content !== original)
    throw new Error("Main preview checkbox did not update only its task marker");
  await until(
    reopened,
    "document.querySelector('[data-pad-markdown] input[type=checkbox]')?.checked === false",
    "Main save did not synchronize the small-window preview",
  );
  fs.writeFileSync(path.join(output, "note-main-split.png"), (await main.capturePage()).toPNG());
  await context.hideAndRelease(reopened);
  return {
    defaultTextEditor: true,
    titleAtUpperLeft: true,
    titleInputLimitedAndSaved: true,
    sourceEditing: true,
    clipboardOnNewNote: true,
    relativeImagePath: true,
    imageWidthPreserved: true,
    modeSwitchPreservesSource: true,
    taskTogglePreservesSource: true,
    modeRememberedOnReopen: true,
    mainEditAndSplit: true,
    mainToPadSync: true,
  };
}
