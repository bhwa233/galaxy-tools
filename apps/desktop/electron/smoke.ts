import fs from "node:fs";
import {
  verifyUnifiedNoteList,
  expectNotePresence,
  ensureSourceEditor,
} from "./smoke-note-list.js";
import path from "node:path";
import { verifyNoteModes } from "./smoke-note-modes.js";
import { verifyNoteReminders } from "./smoke-note-reminders.js";
import { verifyTopCapsules } from "./smoke-top-capsules.js";
import { app, screen, type BrowserWindow } from "electron";
import type { NoteLayoutState } from "./note-window-state.js";
import type { NoteWindowSnapshot } from "../src/features/windows/noteWindowState.js";
import type { Capsules } from "./capsules.js";
import type { NotesDataClient } from "./plugins/official/notes-data-client.js";
import type { AppConfig } from "../src/features/settings/types.js";

export interface SmokeContext {
  output: string;
  fullscreenRects: () => Electron.Rectangle[];
  gpuDiagnostics: () => {
    crashCount: number;
    features: Electron.GPUFeatureStatus;
    startedFromUnc: boolean;
    workingDirectoryIsLocal: boolean;
    sandboxEnabled: boolean;
  };
  notes: NotesDataClient;
  config: () => AppConfig;
  configDir: string;
  dataDir: () => string;
  windows: Map<string, BrowserWindow>;
  layouts: Map<string, NoteLayoutState>;
  openNote: (id?: string, view?: "notepad" | "tile") => Promise<string>;
  showMain: () => BrowserWindow;
  showLauncher: () => Promise<BrowserWindow>;
  pauseForBackup: () => Promise<() => void>;
  hideAndRelease: (win: BrowserWindow) => Promise<void>;
  foldAndRelease: (win: BrowserWindow) => Promise<void>;
  capsules: Capsules;
  emit: (name: string, payload?: unknown, target?: BrowserWindow) => void;
  quit: () => void;
}
export async function runSmoke(context: SmokeContext): Promise<void> {
  const { notes, windows, openNote, showMain } = context;
  const checks: Record<string, unknown> = {};
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function clickCapsule(win: BrowserWindow, selector: string, movement = 0) {
    const point = await win.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(rect.x + 20), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    await wait(50);
    if (movement) {
      point.x += movement;
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    }
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await wait(120);
  }
  async function hydrated(source: BrowserWindow | string): Promise<BrowserWindow> {
    let win = typeof source === "string" ? windows.get(source) : source;
    for (let i = 0; i < 100; i++) {
      if (!win && typeof source === "string") win = windows.get(source);
      if (!win) {
        await wait(100);
        continue;
      }
      if (win.isDestroyed()) throw new Error("Window destroyed during load");
      if (
        await win.webContents
          .executeJavaScript(
            "!!window.spark233Desktop && (!!document.querySelector('textarea') || !!document.querySelector('[data-editor-mode]'))",
          )
          .catch(() => false)
      ) {
        await wait(500);
        await ensureSourceEditor(win);
        return win;
      }
      await wait(100);
    }
    throw new Error("Renderer did not hydrate");
  }
  // A completed backup restored commands but left its rejected query banner.
  // Exercise the real renderer and maintenance gate, including action errors.
  async function verifyLauncherMaintenance() {
    const launcher = await context.showLauncher();
    const settledCommands = `document.querySelector('[data-slot="command-list"]')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('[role="option"][data-result-key]')`;
    const untilRenderer = async (predicate: string, failure: string, attempts = 100) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await launcher.webContents.executeJavaScript(predicate).catch(() => false)) return;
        await wait(50);
      }
      checks.launcherFailure = await launcher.webContents.executeJavaScript(`(async () => ({
        text: document.body.innerText, url: location.href,
        busy: document.querySelector('[data-slot="command-list"]')?.getAttribute('aria-busy'),
        items: document.querySelectorAll('[role="option"][data-result-key]').length,
        state: await window.spark233Desktop.invoke('launcher_state')
      }))()`);
      throw new Error(failure);
    };
    await untilRenderer(settledCommands, "Launcher commands did not settle before maintenance");
    const maintenance: Record<string, unknown> = {};
    checks.launcherMaintenance = maintenance;
    let resume: (() => void) | undefined;
    try {
      resume = await context.pauseForBackup();
      const reads = await launcher.webContents.executeJavaScript(`(async () => ({
          state: await window.spark233Desktop.invoke('launcher_state'),
          query: await window.spark233Desktop.invoke('launcher_query', {query:'',sessionId:crypto.randomUUID()})
        }))()`);
      maintenance.stateReadAllowed = reads.state.ok;
      maintenance.queryRejected = !reads.query.ok && reads.query.error.code === "maintenance";
      if (!maintenance.stateReadAllowed || !maintenance.queryRejected)
        throw new Error("Maintenance must allow state reads and reject launcher queries");
      const errorVisible = `Array.from(document.querySelectorAll('[role="alert"] [data-slot="alert-description"]')).some(node => node.textContent === ${JSON.stringify(reads.query.error.message)})`;
      context.emit("plugins-changed", undefined, launcher);
      await untilRenderer(
        errorVisible,
        "Maintenance query rejection was not shown by the renderer",
      );
      maintenance.errorShown = true;
      resume();
      resume = undefined;
      context.emit("plugins-changed", undefined, launcher);
      await untilRenderer(settledCommands, "Launcher commands did not recover after maintenance");
      maintenance.commandsRecovered = true;
      maintenance.afterRecovery = await launcher.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role="alert"] [data-slot="alert-description"]')).map(node => node.textContent)`,
      );
      await untilRenderer(
        `!(${errorVisible})`,
        "Recovered launcher retained its maintenance read error",
      );
      maintenance.transientErrorCleared = true;
      const modeCommand = reads.state.value.commands.find(
        (command: { pluginId: string; id: string; mode?: string }) =>
          command.pluginId === "spark233.notes" && command.id === "search" && command.mode,
      );
      if (!modeCommand)
        throw new Error("Official notes search mode is required for the action regression");
      // The default launcher now shows primary plugin entries. Search for this
      // secondary mode through the real input before testing its action error.
      await launcher.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[role="combobox"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(modeCommand.title)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      // Ready command rows remain actionable while independent native search
      // providers are pending; a populated machine index can take much longer.
      const modeAvailable = `Array.from(document.querySelectorAll('[role="option"][data-result-key]')).some(node => node.getAttribute('aria-disabled') !== 'true' && node.textContent.includes(${JSON.stringify(modeCommand.title)}))`;
      await untilRenderer(modeAvailable, "Notes search mode did not appear for its explicit query");
      resume = await context.pauseForBackup();
      const clicked = await launcher.webContents.executeJavaScript(`(() => {
          const item = Array.from(document.querySelectorAll('[role="option"][data-result-key]')).find(node => node.textContent.includes(${JSON.stringify(modeCommand.title)}));
          if (!item) return false;
          item.click();
          return true;
        })()`);
      if (!clicked) {
        checks.launcherMissingAction = await launcher.webContents.executeJavaScript(`({
          text: document.body.innerText,
          query: document.querySelector('[role="combobox"]')?.value,
          items: Array.from(document.querySelectorAll('[role="option"][data-result-key]')).map(node => node.textContent)
        })`);
        throw new Error("Notes mode action was not available in the real launcher");
      }
      await untilRenderer(
        errorVisible,
        "Maintenance action rejection was not shown by the renderer",
      );
      maintenance.actionErrorShown = true;
      resume();
      resume = undefined;
      context.emit("plugins-changed", undefined, launcher);
      await untilRenderer(
        settledCommands,
        "Notes query did not recover after the rejected mode action",
      );
      maintenance.businessErrorPreserved =
        await launcher.webContents.executeJavaScript(errorVisible);
      if (!maintenance.businessErrorPreserved)
        throw new Error("Successful background reads erased a business action error");
    } finally {
      resume?.();
    }
  }
  async function verifyFinalPluginSave() {
    // Regression: the final note write succeeded, but surface_state re-read the
    // same identity through the fenced public manager and refused the save ack.
    const lifecycleLauncher = await context.showLauncher();
    const pluginCommand = async (command: string, args: unknown) => {
      const result = await lifecycleLauncher.webContents.executeJavaScript(
        `window.spark233Desktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    };
    const autoSave = context.config().noteSurfaceAutoSave;
    const originalFont = context.config().fontSize;
    const originalSurfaceFont = context.config().surfaceFontSize;
    await pluginCommand("config_patch", {
      patch: { noteSurfaceAutoSave: false },
    });
    let notesStopped = false;
    try {
      const fixture = await notes.save({ title: "Final plugin save", content: "", category: "" });
      const editor = windows.get(await openNote(fixture.id))!;
      await hydrated(editor);
      // Two settings panels can hold the same old snapshot. Each must submit
      // only its edited field, so the second window cannot revert the first.
      const denied = await editor.webContents.executeJavaScript(
        "window.spark233Desktop.invoke('config_patch', {patch:{fontSize:18}})",
      );
      if (denied.ok || denied.error.code !== "permissionDenied")
        throw new Error("A note renderer could modify host configuration");
      checks.noteAdministrationDenied = true;
      await pluginCommand("settings_open", { page: "general" });
      const settings = windows.get("settings")!;
      const settingsBefore = await settings.webContents.executeJavaScript(
        "window.spark233Desktop.invoke('config_get')",
      );
      const launcherBefore = context.config();
      const fontSize = launcherBefore.fontSize === 18 ? 19 : 18;
      const surfaceFontSize = settingsBefore.value.surfaceFontSize === 20 ? 21 : 20;
      await pluginCommand("config_patch", { patch: { fontSize } });
      const patched = await settings.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('config_patch', {patch:{surfaceFontSize:${surfaceFontSize}}})`,
      );
      if (
        !patched.ok ||
        patched.value.fontSize !== fontSize ||
        patched.value.surfaceFontSize !== surfaceFontSize
      )
        throw new Error("A stale settings window reverted another window's config patch");
      const forbidden = await settings.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('config_patch', {patch:{dataDir:${JSON.stringify(context.dataDir())}}})`,
      );
      const obsolete = await settings.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('config_save', {config:${JSON.stringify(settingsBefore.value)}})`,
      );
      if (
        forbidden.ok ||
        forbidden.error.code !== "invalidPayload" ||
        obsolete.ok ||
        obsolete.error.code !== "obsoleteClient"
      )
        throw new Error("Config writes accepted a root change or an obsolete full snapshot");
      checks.independentSettingsPatches = true;
      const finalContent = "停用插件前的未保存正文\n";
      await editor.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(finalContent)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      await wait(80);
      await pluginCommand("plugins_enable", { pluginId: "spark233.notes", enabled: false });
      notesStopped = true;
      if (!editor.isDestroyed()) throw new Error("Saved plugin stop left the editor alive");
      await pluginCommand("plugins_enable", { pluginId: "spark233.notes", enabled: true });
      notesStopped = false;
      if ((await notes.get(fixture.id)).content !== finalContent)
        throw new Error("Plugin stop/restart lost the final renderer save");
      checks.finalPluginSave = true;
    } finally {
      if (notesStopped)
        await pluginCommand("plugins_enable", { pluginId: "spark233.notes", enabled: true });
      await pluginCommand("config_patch", {
        patch: {
          noteSurfaceAutoSave: autoSave,
          fontSize: originalFont,
          surfaceFontSize: originalSurfaceFont,
        },
      });
    }
    // Restored windows must finish their ready handshake before the final quit.
    for (const [label, restored] of windows)
      if (context.layouts.get(label)?.view !== "launcher") await hydrated(restored);
  }
  try {
    if (
      process.argv.includes("--smoke-launcher-maintenance") ||
      process.argv.includes("--smoke-notes-final-save")
    ) {
      if (process.argv.includes("--smoke-launcher-maintenance")) {
        if (!(await notes.list()).length)
          await notes.save({
            title: "Smoke maintenance fixture",
            content: "Controlled search result",
            category: "",
          });
        await verifyLauncherMaintenance();
      }
      if (process.argv.includes("--smoke-notes-final-save")) await verifyFinalPluginSave();
      fs.mkdirSync(path.dirname(context.output), { recursive: true });
      fs.writeFileSync(
        context.output,
        JSON.stringify(
          {
            ok: true,
            runtime: { packaged: app.isPackaged, electron: process.versions.electron },
            checks,
          },
          null,
          2,
        ),
      );
      return;
    }
    checks.initialNoteCount = (await notes.list()).length;
    // The launcher no longer manufactures a blank note on first startup.
    // Existing editor regressions still need an explicit controlled document.
    if (!(await notes.list()).length)
      await notes.save({
        title: "Smoke editor fixture",
        content: "# Controlled smoke document\n",
        category: "",
      });
    const main = showMain();
    await hydrated(main);
    checks.topCapsules = await verifyTopCapsules(context, main);
    checks.noteModes = await verifyNoteModes(context, main);
    checks.noteReminders = await verifyNoteReminders(context, main);
    const restoredPins = [...context.layouts.values()].filter(
      (entry) => entry.noteId && entry.topmost,
    );
    const initial = (await main.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('note_window_states')",
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
      (await notes.list()).find((n) => n.title === "未展示置顶恢复验证")?.id ??
      (
        await notes.save({
          title: "未展示置顶恢复验证",
          content: "只保留置顶偏好，不打开窗口",
          category: "",
        })
      ).id;
    await main.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('note_set_pinned',{noteId:" +
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
    const note = await notes.save({
      title: "Electron 中文验证",
      content: "# 测试\n- [ ] 保留中文\n**Markdown**\n",
      category: "",
    });
    const unified = await verifyUnifiedNoteList(context, main, note);
    checks.unifiedList = unified.checks;
    const { label, win } = unified;
    await hydrated(win);
    const ipc = await win.webContents.executeJavaScript(`(async () => {
      const result = await window.spark233Desktop.invoke('notes_get', { id: ${JSON.stringify(note.id)} });
      const denial = await window.spark233Desktop.invoke('read_external_file', { path: ${JSON.stringify(path.join(context.configDir, "config.json"))} });
      return { node: typeof require, bridge: !!window.spark233Desktop, note: result, denial };
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
    if (!win.isDestroyed() || (await notes.get(note.id)).content !== dirtyText)
      throw new Error("Close/release lost unsaved content");
    await expectNotePresence(main, note.id, "hidden");
    checks.durableClose = true;
    checks.rendererReleased = true;
    const reopened = windows.get(await openNote(note.id))!;
    await hydrated(reopened);
    checks.restored = await reopened.webContents.executeJavaScript(
      `document.querySelector('textarea').value === ${JSON.stringify(dirtyText)}`,
    );
    if (!checks.restored) throw new Error("Reopen lost content");
    await reopened.webContents.executeJavaScript(
      `window.spark233Desktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
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
      `window.spark233Desktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
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
    const failureText = "保存失败时保留这段中文\n";
    await reopened.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(failureText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(80);
    const metadataFile = path.join(context.dataDir(), "metadata.json");
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
    const relativeImage = await notes.saveImage(
      note.id,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
        "base64",
      ),
      "png",
    );
    const imagePath = await notes.resolveImage(relativeImage);
    checks.imageFetch = await reopened.webContents.executeJavaScript(
      `fetch('spark233://asset/' + encodeURIComponent(${JSON.stringify(imagePath)})).then(async r => ({ status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength }))`,
    );
    checks.image = await reopened.webContents.executeJavaScript(
      `(async () => { const img = new Image(); img.src = 'spark233://asset/' + encodeURIComponent(${JSON.stringify(imagePath)}); await img.decode(); return img.naturalWidth; })()`,
    );
    checks.protocolDenied = await reopened.webContents.executeJavaScript(
      `fetch('spark233://asset/' + encodeURIComponent(${JSON.stringify(path.join(context.configDir, "config.json"))})).then(r => r.status)`,
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
      (await notes.get(note.id)).content !== failureText
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
    const capsuleInputErrors: string[] = [];
    queueWin.webContents.on("console-message", (details) => {
      if (details.level === "error") capsuleInputErrors.push(details.message);
    });
    await queueWin.webContents.executeJavaScript(`(() => {
      window.capsuleInputEvents = [];
      for (const type of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','click']) {
        document.addEventListener(type,event=>window.capsuleInputEvents.push({type,button:event.button,detail:event.detail,id:event.target.closest('[data-capsule-id]')?.dataset.capsuleId}),true);
      }
    })()`);
    for (let i = 0; i < 2; i++) {
      const n = await notes.save({
        title: `队列验证 ${i + 1}`,
        content: "# 胶囊预览\n- [ ] 任务\n",
        category: "",
      });
      const w = windows.get(await openNote(n.id))!;
      await hydrated(w);
      w.setBounds(expandedBounds);
      await context.foldAndRelease(w);
    }
    queue = owner()!;
    if (queue.win !== queueWin || queue.snapshot.items.filter((i) => !i.master).length < 3)
      throw new Error("Collapsed notes did not share one edge host");
    const denial = await queueWin.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('notes_delete',{id:" + JSON.stringify(note.id) + "})",
    );
    if (denial.ok) throw new Error("Capsule host crossed its write capability boundary");
    const clickMaster = () => clickCapsule(queueWin, ".capsule-master", 2);
    await clickMaster();
    await wait(120);
    checks.capsulePointerInput = {
      events: await queueWin.webContents.executeJavaScript("window.capsuleInputEvents"),
      errors: capsuleInputErrors,
    };
    if (queue.snapshot.items.length !== 1) throw new Error("Master did not collapse its queue");
    await clickMaster();
    await wait(120);
    if (queue.snapshot.items.length < 4) throw new Error("Master did not restore its queue");
    // A drag that loses capture must not become a click, and must not leave a stuck gesture.
    const dragTarget = `[data-capsule-id="${note.id}"]`;
    const dragPoint = await queueWin.webContents.executeJavaScript(`(() => {
      const r=document.querySelector(${JSON.stringify(dragTarget)}).getBoundingClientRect();
      return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)};
    })()`);
    queueWin.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...dragPoint,
    });
    queueWin.webContents.sendInputEvent({ type: "mouseMove", x: dragPoint.x + 12, y: dragPoint.y });
    await wait(150);
    if (!context.capsules.surfaces.has("drag"))
      throw new Error("Pointer movement did not start a capsule drag");
    await queueWin.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(dragTarget)}).dispatchEvent(new Event('lostpointercapture',{bubbles:true}))`,
    );
    queueWin.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: dragPoint.x + 12,
      y: dragPoint.y,
    });
    await wait(150);
    if (
      windows.has(label) ||
      !context.layouts.get(label)!.folded ||
      context.capsules.surfaces.has("drag")
    )
      throw new Error("Cancelled capsule drag opened a note or left a drag window");
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
        "window.spark233Desktop.invoke('capsule_hover',{id:" + JSON.stringify(note.id) + "})",
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
    await clickCapsule(queueWin, `[data-capsule-id="${note.id}"]`);
    const restored = await hydrated(label);
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
      (await notes.get(note.id)).content !== failureText ||
      context.layouts.get(label)!.topmost !== pinBeforeClose ||
      windows.has(label)
    )
      throw new Error("Capsule close lost content, pin preference, or reopened the editor");
    if (owner()) throw new Error("Closed capsule remained in the edge queue");
    const afterClose = windows.get(await openNote(note.id))!;
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
    const floatingNote = await notes.save({
      title: "悬浮胶囊点击",
      content: "悬浮展开后正文保持原样",
      category: "",
    });
    const floatingLabel = await openNote(floatingNote.id);
    const floatingEditor = windows.get(floatingLabel)!;
    await hydrated(floatingEditor);
    const floatingBounds = floatingEditor.getBounds();
    await context.foldAndRelease(floatingEditor);
    const floatingLayout = context.layouts.get(floatingLabel)!;
    floatingLayout.capsule = {
      ...floatingLayout.capsule!,
      kind: "floating",
      x: floatingBounds.x,
      y: floatingBounds.y,
    };
    await context.capsules.refresh();
    const floating = context.capsules.surfaces.get(`floating:${floatingNote.id}`)!;
    for (let i = 0; !floating.ready && i < 60; i++) await wait(50);
    if (!floating.ready) throw new Error("Floating capsule did not render");
    await clickCapsule(floating.win, `[data-capsule-id="${floatingNote.id}"]`);
    const floatingRestored = await hydrated(floatingLabel);
    if (floatingLayout.folded) throw new Error("Native click did not open floating capsule");
    if (
      JSON.stringify(floatingRestored.getBounds()) !== JSON.stringify(floatingBounds) ||
      (await notes.get(floatingNote.id)).content !== floatingNote.content
    )
      throw new Error("Floating capsule lost its expanded bounds or note content");
    await context.hideAndRelease(floatingRestored);
    checks.capsules = {
      durableFold: true,
      editorReleased: true,
      sharedQueue: true,
      masterToggle: true,
      nativeClickOpensNote: true,
      floatingClickOpensNote: true,
      smallMovementStillClicks: true,
      cancelledDragDoesNotOpen: true,
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
    await verifyLauncherMaintenance();
    await verifyFinalPluginSave();
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
