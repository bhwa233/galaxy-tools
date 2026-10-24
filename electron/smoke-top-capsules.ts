import fs from "node:fs";
import path from "node:path";
import { Menu, screen, type BrowserWindow } from "electron";
import type { SmokeContext } from "./smoke.js";
import type { NoteLayoutState } from "./note-window-state.js";
import { members, pillWidth, queueGeometry, queueKey } from "./capsule-layout.js";
import type { Edge } from "../src/features/capsules/types.js";

/** Real capsule renderers and native windows, with controlled screen DIPs for drag/hover probes. */
export async function verifyTopCapsules(context: SmokeContext, main: BrowserWindow) {
  const progress = (stage: string) =>
    fs.appendFileSync(
      path.join(path.dirname(context.output), "top-progress.log"),
      `${new Date().toISOString()} ${stage}\n`,
    );
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(test: () => boolean | Promise<boolean>, message: string) {
    for (let i = 0; i < 100; i++) {
      if (await test()) return;
      await wait(50);
    }
    throw new Error(message);
  }
  const display = screen.getPrimaryDisplay(),
    area = display.workArea,
    displayId = String(display.id);
  const topKey = queueKey(displayId, "top");
  const previous = context.capsules.queues.get(topKey);
  const coldPlacement = previous ? { ...previous } : undefined;
  let coldVisibleQueue = false;
  if (previous && fs.existsSync(path.join(context.store.dataDir, "electron-layout.json"))) {
    progress("persist");
    const saved = JSON.parse(
      fs.readFileSync(path.join(context.store.dataDir, "electron-layout.json"), "utf8"),
    );
    const disk = saved.capsuleQueues.find((q: { key: string }) => q.key === topKey);
    if (
      disk &&
      (disk.offset !== previous.offset ||
        disk.scroll !== previous.scroll ||
        disk.collapsed !== previous.collapsed ||
        disk.centered !== previous.centered)
    )
      throw new Error("Cold startup did not restore the top queue's saved placement");
    const restored = members(context.layouts.values(), topKey);
    if (restored.length) {
      const host = context.capsules.surfaces.get(`queue:${topKey}`);
      await until(() => !!host?.ready, "Cold startup did not recreate the top host");
      const expected = queueGeometry(
        area,
        "top",
        previous,
        restored.map((e) => {
          const n = context.store.get(e.noteId!);
          return pillWidth(n.title || n.content.slice(0, 30) || "无标题便签");
        }),
      );
      const actualBounds = host!.win.getBounds();
      // Windows can enforce a 39-DIP native minimum height; the shaped capsule remains 32 DIP.
      if (
        actualBounds.x !== expected.bounds.x ||
        actualBounds.y !== expected.bounds.y ||
        actualBounds.width !== expected.bounds.width ||
        actualBounds.height < expected.bounds.height ||
        host!.snapshot.items[0].rect.height !== expected.master.height
      )
        throw new Error(
          `Cold startup did not restore the top queue's native bounds: ${JSON.stringify({ actual: actualBounds, expected: expected.bounds })}`,
        );
      coldVisibleQueue = true;
      for (const entry of restored)
        await main.webContents.executeJavaScript(
          `window.floralDesktop.invoke('hide_note_on_desktop',{noteId:${JSON.stringify(entry.noteId)}})`,
        );
    }
  }
  context.capsules.queues.delete(topKey);
  const entries: NoteLayoutState[] = [];
  const contents = new Map<string, string>();
  const edgeOf = (entry: NoteLayoutState) => entry.capsule!.edge;
  const kindOf = (entry: NoteLayoutState) => entry.capsule!.kind;
  function seed(index: number) {
    const note = context.store.save({
      title: `顶部横排布局验证 ${index}`,
      content: `顶部便签 ${index}：正文保持原样`,
      category: "",
    });
    const entry: NoteLayoutState = {
      label: `top-smoke-${note.id}`,
      noteId: note.id,
      visible: true,
      folded: true,
      view: "notepad",
      topmost: false,
      everOpened: true,
      bounds: { x: area.x + 120, y: area.y + 80, width: 360, height: 420 },
      capsule: {
        kind: "docked",
        displayId,
        edge: "top",
        order: entries.length,
        x: area.x + 120,
        y: area.y + 80,
      },
    };
    context.layouts.set(entry.label, entry);
    entries.push(entry);
    contents.set(note.id, note.content);
    return entry;
  }
  function surface(entry: NoteLayoutState) {
    const c = entry.capsule!;
    return context.capsules.surfaces.get(
      c.kind === "floating" ? `floating:${entry.noteId}` : `queue:${queueKey(c.displayId, c.edge)}`,
    );
  }
  async function ready(entry: NoteLayoutState) {
    await until(() => !!surface(entry)?.ready, "Capsule host did not become ready");
    const host = surface(entry)!;
    await until(
      () => host.win.webContents.executeJavaScript("!!document.querySelector('[data-capsule-id]')"),
      "Capsule renderer did not hydrate",
    );
    return host;
  }
  async function point(win: BrowserWindow, selector: string) {
    return win.webContents.executeJavaScript(
      `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)};})()`,
    );
  }
  async function click(win: BrowserWindow, selector: string) {
    const p = await point(win, selector);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...p });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...p });
    await wait(100);
  }
  async function drag(entry: NoteLayoutState, master: boolean, target: Electron.Point) {
    const host = await ready(entry),
      p = await point(host.win, master ? ".capsule-master" : `[data-capsule-id="${entry.noteId}"]`);
    const bounds = host.win.getBounds();
    const original = screen.getCursorScreenPoint;
    let cursor = { x: bounds.x + p.x, y: bounds.y + p.y };
    screen.getCursorScreenPoint = () => cursor;
    try {
      host.win.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...p,
      });
      host.win.webContents.sendInputEvent({ type: "mouseMove", x: p.x + 12, y: p.y });
      await until(
        () => context.capsules.surfaces.has("drag"),
        "Pointer movement did not start top capsule drag",
      );
      cursor = target;
      host.win.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        x: p.x + 12,
        y: p.y,
      });
      await until(() => !context.capsules.surfaces.has("drag"), "Top capsule drag did not end");
    } finally {
      screen.getCursorScreenPoint = original;
    }
  }
  async function menuMove(entry: NoteLayoutState, edge: Edge) {
    const host = await ready(entry);
    const original = Menu.prototype.popup;
    let popupItems: Menu["items"] | undefined;
    Menu.prototype.popup = function () {
      popupItems = this.items;
    };
    try {
      await host.win.webContents.executeJavaScript(
        `document.querySelector('[data-capsule-id="${entry.noteId}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
      );
      await until(() => !!popupItems, "Capsule context menu did not open");
      const item = popupItems!.find(
        (i) => i.label === { left: "移到左侧", right: "移到右侧", top: "移到顶部" }[edge],
      );
      if (!item) throw new Error(`Context menu is missing ${edge} docking`);
      item.click(item, host.win, {} as Electron.KeyboardEvent);
      await ready(entry);
    } finally {
      Menu.prototype.popup = original;
    }
  }
  try {
    progress("seed");
    for (let i = 0; i < 4; i++) seed(i + 1);
    context.capsules.refresh();
    context.emit("notes-changed");
    let host = await ready(entries[0]);
    const firstBounds = host.win.getBounds();
    if (
      firstBounds.y !== area.y ||
      Math.abs(firstBounds.x + firstBounds.width / 2 - area.x - area.width / 2) > 1
    )
      throw new Error("New top queue is not centered against its work area");
    const pills = host.snapshot.items;
    if (
      pills.length !== 5 ||
      pills.some((item) => item.rect.y !== 0) ||
      pills.slice(1).some((item, i) => item.rect.x <= pills[i].rect.x)
    )
      throw new Error("Top capsules did not form one horizontal row");
    fs.writeFileSync(
      path.join(path.dirname(context.output), "capsules-top.png"),
      (await host.win.capturePage()).toPNG(),
    );
    progress("menu");
    await menuMove(entries[0], "left");
    if (edgeOf(entries[0]) !== "left") throw new Error("Top to left context action failed");
    await menuMove(entries[0], "right");
    if (edgeOf(entries[0]) !== "right") throw new Error("Left to right context action failed");
    await menuMove(entries[0], "top");
    host = await ready(entries[0]);
    progress("reorder");
    await drag(entries[1], false, {
      x: host.win.getBounds().x + host.win.getBounds().width - 4,
      y: area.y + 16,
    });
    if (members(context.layouts.values(), topKey).at(-1)?.noteId !== entries[1].noteId)
      throw new Error("Top queue did not reorder along the horizontal axis");
    progress("move across edges");
    await drag(entries[0], true, { x: area.x + 16, y: area.y + 240 });
    if (entries.slice(0, 4).some((e) => e.capsule!.edge !== "left"))
      throw new Error("Whole top queue did not move to left edge");
    await drag(entries[0], true, { x: area.x + area.width - 16, y: area.y + 240 });
    if (entries.slice(0, 4).some((e) => e.capsule!.edge !== "right"))
      throw new Error("Whole left queue did not move to right edge");
    await drag(entries[0], true, { x: area.x + area.width / 2, y: area.y + 16 });
    if (entries.slice(0, 4).some((e) => e.capsule!.edge !== "top"))
      throw new Error("Whole side queue did not move to top edge");
    host = await ready(entries[0]);
    const beforeShift = host.win.getBounds().x;
    const shift = beforeShift + host.win.getBounds().width + 60 <= area.x + area.width ? 60 : -60;
    await drag(entries[0], true, { x: beforeShift + 20 + shift, y: area.y + 16 });
    if (
      context.capsules.queues.get(topKey)!.centered !== false ||
      host.win.getBounds().x === beforeShift
    )
      throw new Error("Dragging the top master horizontally did not adjust its anchor");
    progress("cross display");
    let crossDisplayTransfer = false;
    const other = screen.getAllDisplays().find((d) => d.id !== display.id);
    if (other) {
      await drag(entries[0], true, {
        x: other.workArea.x + other.workArea.width / 2,
        y: other.workArea.y + 16,
      });
      if (entries.slice(0, 4).some((e) => e.capsule!.displayId !== String(other.id)))
        throw new Error("Whole queue cross-display transfer failed");
      await drag(entries[0], true, { x: area.x + area.width / 2, y: area.y + 16 });
      crossDisplayTransfer = true;
    }
    progress("detach");
    await drag(entries[0], false, { x: area.x + area.width / 2, y: area.y + area.height / 2 });
    if (kindOf(entries[0]) !== "floating")
      throw new Error("Pulling a folded top capsule away did not make it float");
    await ready(entries[0]);
    await drag(entries[0], false, { x: area.x + area.width / 2, y: area.y + 16 });
    if (kindOf(entries[0]) !== "docked" || edgeOf(entries[0]) !== "top")
      throw new Error("Dragging a floating capsule to the top did not dock it");
    host = await ready(entries[0]);
    progress("open");
    await click(host.win, `[data-capsule-id="${entries[0].noteId}"]`);
    await until(
      () => context.windows.has(entries[0].label),
      "Native top capsule click did not open its note",
    );
    const editor = context.windows.get(entries[0].label)!;
    await until(
      () =>
        editor.webContents.executeJavaScript(
          `document.querySelector('textarea')?.value===${JSON.stringify(contents.get(entries[0].noteId!))}`,
        ),
      "Top capsule opened the wrong content",
    );
    await context.foldAndRelease(editor);
    host = await ready(entries[0]);
    progress("preview");
    const originalCursor = screen.getCursorScreenPoint;
    const hoverPoint = await point(host.win, `[data-capsule-id="${entries[0].noteId}"]`);
    let cursor = { x: host.win.getBounds().x + hoverPoint.x, y: area.y + 16 };
    screen.getCursorScreenPoint = () => cursor;
    try {
      await host.win.webContents.executeJavaScript(
        `window.floralDesktop.invoke('capsule_hover',{id:${JSON.stringify(entries[0].noteId)}})`,
      );
      await until(
        () => !!context.capsules.surfaces.get("preview")?.win.isVisible(),
        "Top hover did not show its preview",
      );
      const preview = context.capsules.surfaces.get("preview")!.win;
      if (preview.getBounds().y < area.y + 32 || preview.isFocusable() || preview.isFocused())
        throw new Error("Top preview is not below the row or stole focus");
      await until(
        () =>
          preview.webContents.executeJavaScript(
            "!!document.querySelector('.capsule-preview-body')",
          ),
        "Top preview did not hydrate",
      );
      await preview.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await wait(180);
      fs.writeFileSync(
        path.join(path.dirname(context.output), "capsules-top-preview.png"),
        (await preview.capturePage()).toPNG(),
      );
      cursor = { x: cursor.x, y: area.y + 35 };
      await wait(250);
      if (!preview.isVisible()) throw new Error("Top hover gap did not retain the preview");
      cursor = { x: preview.getBounds().x + 30, y: preview.getBounds().y + 50 };
      await wait(250);
      if (!preview.isVisible()) throw new Error("Entering top preview did not keep it open");
      cursor = { x: area.x + area.width - 10, y: area.y + area.height - 10 };
      await until(() => !preview.isVisible(), "Leaving top preview did not close it");
    } finally {
      screen.getCursorScreenPoint = originalCursor;
    }
    progress("overflow");
    for (let i = 0; i < Math.max(2, Math.ceil(area.width / 160) - 2); i++) seed(i + 10);
    context.capsules.refresh();
    host = await ready(entries[0]);
    const q = context.capsules.queues.get(topKey)!;
    await host.win.webContents.executeJavaScript(
      "document.querySelector('.capsule-master').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaX:120,deltaY:0}))",
    );
    await until(() => q.scroll > 0, "Horizontal wheel did not scroll top capsules");
    const master = host.snapshot.items[0];
    if (
      master.rect.x !== 0 ||
      host.snapshot.items.some(
        (item) => !item.master && item.rect.x + (item.clip?.x ?? 0) < master.rect.width,
      )
    )
      throw new Error("Scrolled top capsules covered the fixed master");
    progress("collapse");
    const scroll = q.scroll;
    await click(host.win, ".capsule-master");
    await until(() => host.snapshot.items.length === 1, "Top master did not collapse the row");
    await click(host.win, ".capsule-master");
    await until(() => host.snapshot.items.length > 1, "Top master did not reopen the row");
    if (q.scroll !== scroll) throw new Error("Top collapse/reopen forgot horizontal scrolling");
    await until(
      () =>
        host.win.webContents.executeJavaScript(
          `document.querySelectorAll('[data-capsule-id]').length===${host.snapshot.items.length}`,
        ),
      "Top overflow renderer did not finish expanding",
    );
    await host.win.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    fs.writeFileSync(
      path.join(path.dirname(context.output), "capsules-top-overflow.png"),
      (await host.win.capturePage()).toPNG(),
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(context.store.dataDir, "electron-layout.json"), "utf8"),
    );
    const persisted = saved.capsuleQueues.find((item: { key: string }) => item.key === topKey);
    if (
      persisted?.offset !== q.offset ||
      persisted?.scroll !== q.scroll ||
      persisted?.centered !== false
    )
      throw new Error("Top anchor or scrolling was not persisted");
    for (const entry of entries)
      if (context.store.get(entry.noteId!).content !== contents.get(entry.noteId!))
        throw new Error("Docking rewrote a note");
    return {
      horizontalRow: true,
      centeredDefault: true,
      sideAndTopMenu: true,
      reorder: true,
      wholeQueueMovesAcrossEdges: true,
      horizontalMasterDrag: true,
      crossDisplayTransfer,
      floatingAndRedock: true,
      nativeClickOpensNote: true,
      previewBelowWithoutFocus: true,
      previewGapAndExit: true,
      horizontalWheel: true,
      fixedMaster: true,
      collapseRetainsScroll: true,
      placementPersisted: true,
      coldRestoreObserved: Boolean(previous),
      coldVisibleQueue,
      coldPlacement,
      contentPreserved: true,
    };
  } catch (error) {
    progress(`FAILED ${error instanceof Error ? error.stack : String(error)}`);
    throw error;
  } finally {
    progress("cleanup");
    // Use the normal hide command so cold-start probes keep top placement without opening fixtures.
    for (const entry of entries)
      await main.webContents.executeJavaScript(
        `window.floralDesktop.invoke('hide_note_on_desktop',{noteId:${JSON.stringify(entry.noteId)}})`,
      );
  }
}
