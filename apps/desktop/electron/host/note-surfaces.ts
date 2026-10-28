import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { CapsuleQueue } from "../../src/features/capsules/types.js";
import {
  NOTE_WINDOW_STATES_CHANGED,
  type NoteWindowSnapshot,
} from "../../src/features/windows/noteWindowState.js";
import { deriveNoteWindowState } from "../note-window-state.js";
import { AppError } from "../persistence.js";
import { NotesDataClient } from "../plugins/official/notes-data-client.js";
import type { Layout, RuntimeContext } from "../runtime.js";

/** note-surfaces owns this domain; shared state remains in the composition root. */
export function createNoteSurfaces(
  ctx: Pick<
    RuntimeContext,
    | "layouts"
    | "windows"
    | "capsules"
    | "noteStateVersion"
    | "hostConfig"
    | "noteStateFingerprint"
    | "emit"
    | "fullscreenRects"
    | "notesClient"
    | "safeBounds"
    | "hideAndRelease"
    | "refreshTray"
    | "backupRecoveryPending"
    | "layoutsRestored"
    | "notesActive"
    | "layoutTimer"
    | "endLauncherExecutionQuery"
    | "requireNotes"
    | "createWindow"
    | "ready"
    | "launcherPresentationGuard"
    | "pendingManagerOpen"
  >,
) {
  function noteWindowSnapshot(): NoteWindowSnapshot {
    // Desktop state belongs to layouts. Do not read/recover Markdown metadata while publishing
    // a move, hide or pin event; ordinary notes without a layout use the renderer's unopened default.
    const entries = new Map(
      [...ctx.layouts.values()]
        .filter((entry) => entry.noteId && entry.view !== "main")
        .map((entry) => [entry.noteId!, entry]),
    );
    const notes = [...entries].map(([noteId, layout]) => {
      const win = ctx.windows.get(layout.label);
      return deriveNoteWindowState(
        noteId,
        layout,
        !!win && !win.isDestroyed() && win.isVisible(),
        ctx.capsules?.isHidden() ?? false,
      );
    });
    return { version: ctx.noteStateVersion, notes };
  }

  function publishNoteStates(): void {
    if (!ctx.hostConfig) return;
    const snapshot = noteWindowSnapshot(),
      fingerprint = JSON.stringify(snapshot.notes);
    if (fingerprint === ctx.noteStateFingerprint) return;
    ctx.noteStateFingerprint = fingerprint;
    snapshot.version = ++ctx.noteStateVersion;
    ctx.emit(NOTE_WINDOW_STATES_CHANGED, snapshot);
  }

  function applyNoteTopmost(win: BrowserWindow, layout: Layout): void {
    const b = win.getBounds(),
      blocked = ctx.fullscreenRects.some(
        (r) =>
          b.x < r.x + r.width &&
          b.x + b.width > r.x &&
          b.y < r.y + r.height &&
          b.y + b.height > r.y,
      );
    // The default Windows level restacks behind the primary taskbar and can lose
    // topmost on another monitor. This level skips that restack; fullscreen still wins.
    win.setAlwaysOnTop(
      layout.topmost && !blocked,
      process.platform === "win32" ? "pop-up-menu" : "floating",
    );
  }

  async function setNotePinned(id: string, pinned: boolean): Promise<void> {
    await ctx.notesClient.get(id);
    let layout = [...ctx.layouts.values()].find((e) => e.noteId === id && e.view !== "main");
    const created = !layout;
    if (!layout) {
      layout = {
        label: `notepad-${id}`,
        view: "notepad",
        noteId: id,
        bounds: ctx.safeBounds({
          width: ctx.hostConfig.value.surfaceWidth,
          height: ctx.hostConfig.value.surfaceHeight,
        }),
        visible: false,
        folded: false,
        topmost: false,
        everOpened: false,
      };
      ctx.layouts.set(layout.label, layout);
    }
    const before = layout.topmost,
      win = ctx.windows.get(layout.label);
    try {
      layout.topmost = pinned;
      if (win && !win.isDestroyed()) applyNoteTopmost(win, layout);
      await persistLayout();
    } catch (error) {
      layout.topmost = before;
      if (created) ctx.layouts.delete(layout.label);
      if (win && !win.isDestroyed()) applyNoteTopmost(win, layout);
      publishNoteStates();
      throw error;
    }
  }

  async function hideNoteOnDesktop(id: string): Promise<void> {
    await ctx.notesClient.get(id);
    const layout = [...ctx.layouts.values()].find((e) => e.noteId === id && e.view !== "main");
    if (!layout) return;
    const win = ctx.windows.get(layout.label);
    if (win) {
      await ctx.hideAndRelease(win);
      return;
    }
    const wasVisible = layout.visible;
    layout.visible = false;
    try {
      await persistLayout();
    } catch (error) {
      layout.visible = wasVisible;
      throw error;
    }
    ctx.capsules.refresh();
    ctx.refreshTray();
    publishNoteStates();
  }

  async function restoreNotesLayout(data: NotesDataClient): Promise<void> {
    for (const [label, layout] of ctx.layouts)
      if (layout.view !== "launcher") ctx.layouts.delete(label);
    ctx.capsules.queues.clear();
    const value = await data.getState("layout");
    if (value !== null) {
      if (typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.windows))
        throw new AppError("invalidLayout", "布局文件格式无效，请检查 electron-layout.json");
      const saved = value as unknown as { windows: Layout[]; capsuleQueues?: CapsuleQueue[] };
      const noteIds = new Set((await data.list()).map((note) => note.id));
      ctx.capsules.restore(saved.capsuleQueues);
      for (const entry of saved.windows) {
        if (
          !entry ||
          typeof entry.label !== "string" ||
          !["main", "tile", "notepad"].includes(entry.view) ||
          !entry.bounds
        )
          throw new AppError("invalidLayout", "布局文件格式无效，请检查 electron-layout.json");
        if (entry.noteId && !noteIds.has(entry.noteId)) continue;
        if (
          entry.capsule &&
          (!Number.isFinite(entry.capsule.x) ||
            !Number.isFinite(entry.capsule.y) ||
            !Number.isFinite(entry.capsule.order) ||
            !["left", "right", "top"].includes(entry.capsule.edge) ||
            !["floating", "docked"].includes(entry.capsule.kind) ||
            typeof entry.capsule.displayId !== "string")
        )
          throw new AppError("invalidLayout", "胶囊布局格式无效，请检查 electron-layout.json");
        if (entry.folded && !entry.capsule) entry.folded = false;
        ctx.layouts.set(entry.label, entry);
      }
      ctx.capsules.refresh();
    }
  }

  async function persistLayout(data = ctx.notesClient): Promise<void> {
    // Screen/plugin callbacks can run before the saved layout has been read.
    // Never replace it with the still-empty startup map, including on early quit.
    if (ctx.backupRecoveryPending || !ctx.layoutsRestored || !ctx.notesActive) return;
    if (ctx.layoutTimer) clearTimeout(ctx.layoutTimer);
    await data.putState(
      "layout",
      JSON.parse(
        JSON.stringify({
          version: 2,
          capsuleQueues: [...(ctx.capsules?.queues.values() ?? [])],
          windows: [...ctx.layouts.values()].filter(
            (entry) => entry.view === "main" || entry.noteId,
          ),
        }),
      ),
    );
    publishNoteStates();
  }

  function scheduleLayout(): void {
    clearTimeout(ctx.layoutTimer);
    ctx.layoutTimer = setTimeout(() => {
      void persistLayout().catch((error) => console.error("layout-save", error));
    }, 250);
  }

  function showMain(): BrowserWindow {
    ctx.endLauncherExecutionQuery();
    ctx.requireNotes();
    const layout = ctx.layouts.get("main") ?? {
      label: "main",
      view: "main",
      bounds: ctx.safeBounds({}, true),
      visible: true,
      topmost: false,
    };
    layout.visible = true;
    const win = ctx.createWindow(layout);
    if (ctx.ready.has(win.id)) {
      win.show();
      win.focus();
    }
    return win;
  }

  async function openNote(
    noteId?: string,
    view?: "notepad" | "tile",
    bounds?: Electron.Rectangle,
  ): Promise<string> {
    ctx.requireNotes();
    if (noteId) await ctx.notesClient.get(noteId);
    ctx.endLauncherExecutionQuery();
    const found = noteId
      ? [...ctx.layouts.values()].find(
          (entry) => entry.noteId === noteId && (entry.view === "notepad" || entry.view === "tile"),
        )
      : undefined;
    const label = found?.label ?? `${view ?? "notepad"}-${noteId || randomUUID()}`;
    if (!ctx.launcherPresentationGuard()()) return label;
    const layout: Layout = found ?? {
      label,
      view: view ?? "notepad",
      noteId,
      bounds: ctx.safeBounds(
        bounds ?? {
          width: ctx.hostConfig.value.surfaceWidth,
          height: ctx.hostConfig.value.surfaceHeight,
        },
      ),
      visible: true,
      topmost: false,
    };
    layout.visible = true;
    layout.folded = false;
    const modeChanged = !!view && layout.view !== view;
    if (modeChanged && view) {
      layout.view = view;
      if (!ctx.windows.has(label) && !bounds)
        layout.bounds = ctx.safeBounds({
          ...layout.bounds,
          width: 360,
          height: view === "tile" ? 240 : 420,
        });
    }
    if (bounds) layout.bounds = ctx.safeBounds(bounds);
    const win = ctx.createWindow(layout);
    if (modeChanged && ctx.ready.has(win.id))
      ctx.emit("surface-mode-request", view === "tile" ? "tile" : "pad", win);
    if (ctx.ready.has(win.id)) {
      win.show();
      win.focus();
    }
    scheduleLayout();
    ctx.refreshTray();
    ctx.capsules?.refresh();
    return label;
  }

  async function openNoteWithAnchor(noteId: string, taskText?: string): Promise<void> {
    await ctx.notesClient.get(noteId);
    if (!ctx.launcherPresentationGuard()()) return;
    const main = showMain();
    // 旧载荷是纯 id 字符串；带任务锚点的提醒用对象载荷，渲染端两者都接受。
    const payload: string | { noteId: string; taskText?: string } = taskText
      ? { noteId, taskText }
      : noteId;
    if (ctx.ready.has(main.id)) ctx.emit("open-note", payload, main);
    else ctx.pendingManagerOpen = { windowId: main.id, payload };
  }
  return {
    noteWindowSnapshot,
    publishNoteStates,
    applyNoteTopmost,
    setNotePinned,
    hideNoteOnDesktop,
    restoreNotesLayout,
    persistLayout,
    scheduleLayout,
    showMain,
    openNote,
    openNoteWithAnchor,
  };
}
