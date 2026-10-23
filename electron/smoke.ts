import fs from "node:fs";
import { verifyUnifiedNoteList, expectNotePresence } from "./smoke-note-list.js";
import path from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import type { NoteLayoutState } from "./note-window-state.js";
import type { NoteWindowSnapshot } from "../src/features/windows/noteWindowState.js";
import type { Capsules } from "./capsules.js";
import type { NoteStore } from "./store.js";

export interface SmokeContext {
  output: string;
  gpuDiagnostics: () => {
    crashCount: number;
    features: Electron.GPUFeatureStatus;
    startedFromUnc: boolean;
    workingDirectoryIsLocal: boolean;
    sandboxEnabled: boolean;
  };
  store: NoteStore;
  windows: Map<string, BrowserWindow>;
  layouts: Map<string, NoteLayoutState>;
  openNote: (id?: string, view?: "notepad" | "tile") => string;
  showMain: () => BrowserWindow;
  hideAndRelease: (win: BrowserWindow) => Promise<void>;
  foldAndRelease: (win: BrowserWindow) => Promise<void>;
  capsules: Capsules;
  emit: (name: string, payload?: unknown, target?: BrowserWindow) => void;
  quit: () => void;
}
export async function runSmoke(context: SmokeContext): Promise<void> {
  const { store, windows, openNote, showMain } = context;
  const checks: Record<string, unknown> = {};
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function hydrated(win: BrowserWindow) {
    for (let i = 0; i < 100; i++) {
      if (win.isDestroyed()) throw new Error("Window destroyed during load");
      if (
        await win.webContents
          .executeJavaScript("!!window.floralDesktop && !!document.querySelector('textarea')")
          .catch(() => false)
      ) {
        await wait(500);
        return;
      }
      await wait(100);
    }
    throw new Error("Renderer did not hydrate");
  }
  try {
    const main = showMain();
    await hydrated(main);
    const restoredPins = [...context.layouts.values()].filter(
      (entry) => entry.noteId && entry.topmost,
    );
    const initial = (await main.webContents.executeJavaScript(
      "window.floralDesktop.invoke('note_window_states')",
    )) as { ok: boolean; value: NoteWindowSnapshot };
    if (!initial.ok) throw new Error("Failed to read restored pin state");
    for (const entry of restoredPins) {
      const state = initial.value.notes.find((n) => n.noteId === entry.noteId);
      if (!state?.pinned) throw new Error("Restored layout lost a pin preference");
      if (
        entry.everOpened === false &&
        (state.presence !== "unopened" || context.windows.has(entry.label))
      )
        throw new Error("Restoring pin-only preference opened a desktop window");
    }
    checks.restoredPinPreferences = restoredPins.length;
    const pinOnlyId =
      store.list().find((n) => n.title === "未展示置顶恢复验证")?.id ??
      store.save({
        title: "未展示置顶恢复验证",
        content: "只保留置顶偏好，不打开窗口",
        category: "",
      }).id;
    await main.webContents.executeJavaScript(
      "window.floralDesktop.invoke('note_set_pinned',{noteId:" +
        JSON.stringify(pinOnlyId) +
        ",pinned:true})",
    );
    context.emit("notes-changed");
    await expectNotePresence(main, pinOnlyId, "unopened");
    const errors: string[] = [];
    for (const win of windows.values())
      win.webContents.on("console-message", (details) => {
        if (details.level === "error") errors.push(details.message);
      });
    const note = store.save({
      title: "Electron 中文验证",
      content: "# 测试\n- [ ] 保留中文\n**Markdown**\n",
      category: "",
    });
    const unified = await verifyUnifiedNoteList(context, main, note);
    checks.unifiedList = unified.checks;
    const { label, win } = unified;
    await hydrated(win);
    const ipc = await win.webContents.executeJavaScript(`(async () => {
      const result = await window.floralDesktop.invoke('notes_get', { id: ${JSON.stringify(note.id)} });
      const denial = await window.floralDesktop.invoke('read_external_file', { path: ${JSON.stringify(path.join(store.configDir, "config.json"))} });
      return { node: typeof require, bridge: !!window.floralDesktop, note: result, denial };
    })()`);
    if (
      !ipc.note.ok ||
      ipc.note.value.content !== note.content ||
      ipc.node !== "undefined" ||
      ipc.denial.ok
    )
      throw new Error(`IPC/sandbox failed: ${JSON.stringify(ipc)}`);
    checks.ipc = ipc;
    const oldBounds = win.getBounds();
    win.setBounds({ ...oldBounds, x: oldBounds.x + 30, y: oldBounds.y + 20 });
    checks.moved = win.getBounds().x === oldBounds.x + 30;
    const dirtyText = "关闭前立即输入：中文不丢失 **bold**\n";
    await win.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(dirtyText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(80);
    await context.hideAndRelease(win);
    if (!win.isDestroyed() || store.get(note.id).content !== dirtyText)
      throw new Error("Close/release lost unsaved content");
    await expectNotePresence(main, note.id, "hidden");
    checks.durableClose = true;
    checks.rendererReleased = true;
    const reopened = windows.get(openNote(note.id))!;
    await hydrated(reopened);
    checks.restored = await reopened.webContents.executeJavaScript(
      `document.querySelector('textarea').value === ${JSON.stringify(dirtyText)}`,
    );
    if (!checks.restored) throw new Error("Reopen lost content");
    await reopened.webContents.executeJavaScript(
      `window.floralDesktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
    );
    await wait(350);
    checks.sameWindowTile = await reopened.webContents.executeJavaScript(
      "!!document.querySelector('[data-surface-mode=tile]')",
    );
    // Regression: the native paper-menu interceptor swallowed the tile's edit action.
    // Exercise the user's actual right-click path instead of reopening through backend IPC.
    reopened.webContents.sendInputEvent({ type: "mouseDown", button: "right", x: 100, y: 100 });
    reopened.webContents.sendInputEvent({ type: "mouseUp", button: "right", x: 100, y: 100 });
    await wait(200);
    const tileMenuOpened = await reopened.webContents.executeJavaScript(`(() => {
      const action = document.querySelector('button[data-surface-action="switchToPad"]:not([aria-label])');
      if (!action) return false;
      action.click();
      return true;
    })()`);
    if (!tileMenuOpened) throw new Error("Tile right-click has no return-to-note action");
    await wait(350);
    checks.sameWindowEditor = await reopened.webContents.executeJavaScript(
      `document.querySelector('textarea')?.value === ${JSON.stringify(dirtyText)}`,
    );
    if (!checks.sameWindowTile || !checks.sameWindowEditor)
      throw new Error("Existing note window did not switch display/edit mode");
    await reopened.webContents.executeJavaScript(
      `window.floralDesktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
    );
    await wait(200);
    await reopened.webContents.executeJavaScript(
      "document.querySelector('button[data-surface-action=\"switchToPad\"][aria-label]').click()",
    );
    await wait(350);
    if (!(await reopened.webContents.executeJavaScript("!!document.querySelector('textarea')")))
      throw new Error("Tile edit button did not return to the note editor");
    checks.tileReturnViaContextMenuAndButton = true;
    // A real filesystem failure must keep the renderer and its dirty text alive.
    const failureText = "保存失败时保留这段中文";
    await reopened.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(failureText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(80);
    const metadataFile = path.join(store.dataDir, "metadata.json");
    const backup = `${metadataFile}.smoke-backup`;
    fs.renameSync(metadataFile, backup);
    fs.mkdirSync(metadataFile);
    let refused = false;
    try {
      await context.foldAndRelease(reopened);
    } catch {
      refused = true;
    } finally {
      fs.rmdirSync(metadataFile);
      fs.renameSync(backup, metadataFile);
    }
    checks.saveFailurePreservesWindow =
      refused &&
      !reopened.isDestroyed() &&
      (await reopened.webContents.executeJavaScript(
        `document.querySelector('textarea').value === ${JSON.stringify(failureText)}`,
      ));
    if (!checks.saveFailurePreservesWindow)
      throw new Error("Save failure destroyed the dirty editor");
    const relativeImage = store.saveImage(
      note.id,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
        "base64",
      ),
      "png",
    );
    checks.imageFetch = await reopened.webContents.executeJavaScript(
      `fetch('floral://asset/' + encodeURIComponent(${JSON.stringify(path.join(store.dataDir, relativeImage))})).then(async r => ({ status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength }))`,
    );
    checks.image = await reopened.webContents.executeJavaScript(
      `(async () => { const img = new Image(); img.src = 'floral://asset/' + encodeURIComponent(${JSON.stringify(path.join(store.dataDir, relativeImage))}); await img.decode(); return img.naturalWidth; })()`,
    );
    checks.protocolDenied = await reopened.webContents.executeJavaScript(
      `fetch('floral://asset/' + encodeURIComponent(${JSON.stringify(path.join(store.configDir, "config.json"))})).then(r => r.status)`,
    );
    if (checks.image !== 1 || checks.protocolDenied !== 403)
      throw new Error("Asset protocol boundary failed");
    const expandedBounds = reopened.getBounds();
    await context.foldAndRelease(reopened);
    await expectNotePresence(main, note.id, "capsule");
    const layout = context.layouts.get(label)!;
    if (
      !reopened.isDestroyed() ||
      !layout.folded ||
      !layout.visible ||
      store.get(note.id).content !== failureText
    )
      throw new Error("Fold did not save and release its editor");
    const owner = () =>
      [...context.capsules.surfaces.values()].find(
        (s) => s.snapshot.kind === "queue" && s.snapshot.items.some((i) => i.id === note.id),
      );
    let queue = owner();
    if (!queue) throw new Error("Folded note has no edge queue");
    for (let i = 0; i < 100 && !queue.ready; i++) await wait(100);
    await wait(150);
    if (!queue.ready || !queue.win.isVisible()) throw new Error("Edge host did not render");
    const queueWin = queue.win;
    for (let i = 0; i < 2; i++) {
      const n = store.save({
        title: `队列验证 ${i + 1}`,
        content: "# 胶囊预览\n- [ ] 任务\n",
        category: "",
      });
      const w = windows.get(openNote(n.id))!;
      await hydrated(w);
      w.setBounds(expandedBounds);
      await context.foldAndRelease(w);
    }
    queue = owner()!;
    if (queue.win !== queueWin || queue.snapshot.items.filter((i) => !i.master).length < 3)
      throw new Error("Collapsed notes did not share one edge host");
    const denial = await queueWin.webContents.executeJavaScript(
      "window.floralDesktop.invoke('notes_delete',{id:" + JSON.stringify(note.id) + "})",
    );
    if (denial.ok) throw new Error("Capsule host crossed its write capability boundary");
    const clickMaster = () =>
      queueWin.webContents.executeJavaScript("document.querySelector('.capsule-master').click()");
    await clickMaster();
    await wait(120);
    if (queue.snapshot.items.length !== 1) throw new Error("Master did not collapse its queue");
    await clickMaster();
    await wait(120);
    if (queue.snapshot.items.length < 4) throw new Error("Master did not restore its queue");
    // Move only the test window under the existing cursor, then exercise renderer hover IPC.
    // This proves the real preview/no-focus path, not physical mouse gestures or mixed-DPI dragging.
    let cursor = screen.getCursorScreenPoint();
    const item = queue.snapshot.items.find((i) => i.id === note.id)!;
    const originalQueueBounds = queueWin.getBounds();
    let preview = context.capsules.surfaces.get("preview");
    // Native hover admission uses the real cursor. The user may keep using the desktop during
    // a probe, so retry positioning the test host rather than assuming the cursor stayed still.
    for (let attempt = 0; attempt < 12; attempt++) {
      cursor = screen.getCursorScreenPoint();
      queueWin.setPosition(cursor.x - item.rect.x - 20, cursor.y - item.rect.y - 16);
      await queueWin.webContents.executeJavaScript(
        "window.floralDesktop.invoke('capsule_hover',{id:" + JSON.stringify(note.id) + "})",
      );
      await wait(350);
      preview = context.capsules.surfaces.get("preview");
      if (preview?.ready && preview.win.isVisible()) break;
    }
    checks.previewDiagnostics = {
      cursor,
      currentCursor: screen.getCursorScreenPoint(),
      item,
      queueBounds: queueWin.isDestroyed() ? null : queueWin.getBounds(),
      present: !!preview,
      ready: preview?.ready,
      visible: preview?.win.isVisible(),
      focusable: preview?.win.isFocusable(),
      focused: preview?.win.isFocused(),
    };
    if (!preview?.win.isVisible() || preview.win.isFocusable() || preview.win.isFocused())
      throw new Error("Hover preview was missing or activated");
    const previewText = await preview.win.webContents.executeJavaScript("document.body.innerText");
    if (!previewText.includes(failureText))
      throw new Error("Preview content differs from durable note");
    fs.writeFileSync(
      path.join(path.dirname(context.output), "capsule-preview.png"),
      (await preview.win.capturePage()).toPNG(),
    );
    queueWin.setBounds(originalQueueBounds);
    await queueWin.webContents.executeJavaScript(
      "document.querySelector('[data-capsule-id=" + JSON.stringify(note.id) + "]').click()",
    );
    const restored = windows.get(label)!;
    await hydrated(restored);
    if (
      context.layouts.get(label)!.folded ||
      JSON.stringify(restored.getBounds()) !== JSON.stringify(expandedBounds)
    )
      throw new Error("Capsule open lost expanded geometry");
    await expectNotePresence(main, note.id, "desktop");
    checks.notePresenceTransitions = true;
    fs.writeFileSync(
      path.join(path.dirname(context.output), "note-states.png"),
      (await main.capturePage()).toPNG(),
    );
    await context.foldAndRelease(restored);
    await wait(200);
    const pinBeforeClose = context.layouts.get(label)!.topmost;
    const capsuleControl = await queueWin.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-capsule-id=${JSON.stringify(note.id)}]');
      const close = document.querySelector('[data-capsule-close=${JSON.stringify(note.id)}]');
      const text = button.querySelector('.capsule-label').getBoundingClientRect();
      const pill = button.getBoundingClientRect();
      const x = close.getBoundingClientRect();
      return { x: Math.round(x.x + x.width/2), y: Math.round(x.y + x.height/2),
        titleReadable: text.width >= 75 && text.right <= x.left,
        closeOnRight: x.right <= pill.right && x.left > pill.x + pill.width/2,
        fullTitle: button.title === button.querySelector('.capsule-label').textContent };
    })()`);
    if (!capsuleControl.titleReadable || !capsuleControl.closeOnRight || !capsuleControl.fullTitle)
      throw new Error(`Capsule title/close layout failed: ${JSON.stringify(capsuleControl)}`);
    fs.writeFileSync(
      path.join(path.dirname(context.output), "capsule-controls.png"),
      (await queueWin.capturePage()).toPNG(),
    );
    queueWin.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      x: capsuleControl.x,
      y: capsuleControl.y,
      clickCount: 1,
    });
    queueWin.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      x: capsuleControl.x,
      y: capsuleControl.y,
      clickCount: 1,
    });
    await expectNotePresence(main, note.id, "hidden");
    if (
      store.get(note.id).content !== failureText ||
      context.layouts.get(label)!.topmost !== pinBeforeClose ||
      windows.has(label)
    )
      throw new Error("Capsule close lost content, pin preference, or reopened the editor");
    if (owner()) throw new Error("Closed capsule remained in the edge queue");
    const afterClose = windows.get(openNote(note.id))!;
    await hydrated(afterClose);
    if (
      !(await afterClose.webContents.executeJavaScript(
        `document.querySelector('textarea').value === ${JSON.stringify(failureText)}`,
      ))
    )
      throw new Error("Hidden capsule did not reopen with saved content");
    checks.capsuleClose = {
      hidden: true,
      contentPreserved: true,
      pinPreserved: true,
      noAccidentalOpen: true,
      canReopen: true,
      titleReadable: true,
      closeOnRight: true,
    };
    checks.capsules = {
      durableFold: true,
      editorReleased: true,
      sharedQueue: true,
      masterToggle: true,
      capabilityDenied: true,
      previewNoFocus: true,
      previewContent: true,
      expandedGeometry: true,
    };
    checks.gpu = context.gpuDiagnostics();
    const gpu = context.gpuDiagnostics();
    if (
      process.platform === "win32" &&
      (gpu.crashCount !== 0 || gpu.features.gpu_compositing !== "enabled" || !gpu.sandboxEnabled)
    )
      throw new Error(`Hardware GPU/sandbox check failed: ${JSON.stringify(gpu)}`);
    checks.errors = errors;
    fs.mkdirSync(path.dirname(context.output), { recursive: true });
    fs.writeFileSync(
      context.output,
      JSON.stringify(
        {
          ok: true,
          runtime: {
            packaged: app.isPackaged,
            electron: process.versions.electron,
            platform: process.platform,
          },
          checks,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    fs.mkdirSync(path.dirname(context.output), { recursive: true });
    fs.writeFileSync(
      context.output,
      JSON.stringify(
        {
          ok: false,
          checks,
          error:
            error instanceof Error
              ? error.stack
              : JSON.stringify(error, Object.getOwnPropertyNames(Object(error))),
        },
        null,
        2,
      ),
    );
  } finally {
    context.quit();
  }
}
