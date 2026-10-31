import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { presentationCount } from "./presentation-epoch.js";

/** window-close owns this domain; shared state remains in the composition root. */
export function createWindowClose(
  ctx: Pick<
    RuntimeContext,
    | "crashedWindows"
    | "ready"
    | "pending"
    | "layouts"
    | "labelOf"
    | "emit"
    | "releasing"
    | "remember"
    | "capsules"
    | "persistLayout"
    | "hideHostWindow"
    | "refreshTray"
    | "hostShutdown"
  >,
) {
  // Keeps only the most recently closed plugin workspace warm; any other
  // business window is destroyed as before.
  let retained: BrowserWindow | undefined;

  async function prepare(win: BrowserWindow): Promise<boolean> {
    if (win.isDestroyed()) return true;
    // A dead renderer cannot acknowledge saving. Its plugin has already been
    // marked failed; preserve the last durable state and let live owners save.
    if (ctx.crashedWindows.has(win.id)) return true;
    if (!ctx.ready.has(win.id)) return false;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          ctx.pending.delete(requestId);
          resolve(false);
        },
        ctx.layouts.get(ctx.labelOf(win))?.hostPage === "settings" ? 120000 : 10000,
      );
      ctx.pending.set(requestId, {
        windowId: win.id,
        resolve: (result) => {
          clearTimeout(timer);
          ctx.pending.delete(requestId);
          resolve(result);
        },
      });
      ctx.emit("desktop:prepare-close", { requestId }, win);
    });
  }

  function hideAndRelease(win: BrowserWindow): Promise<void> {
    return releaseWindow(win, false);
  }

  function foldAndRelease(win: BrowserWindow): Promise<void> {
    return releaseWindow(win, true);
  }

  function releaseWindow(win: BrowserWindow, fold: boolean): Promise<void> {
    const existing = ctx.releasing.get(win.id);
    if (existing) return existing;
    const operation = (async () => {
      // A save acknowledgement may take seconds. If the user re-opens the same
      // window while we wait, the stale close must not hide it or flip layout.
      const presented = presentationCount(win);
      if (!(await prepare(win)))
        throw new AppError("saveFailed", "保存未完成，已保留窗口，请先保存再收起");
      const layout = ctx.layouts.get(ctx.labelOf(win));
      if (!layout || win.isDestroyed()) return;
      if (presentationCount(win) !== presented) return;
      ctx.remember(win);
      if (fold && layout.view !== "main" && layout.noteId) await ctx.capsules.fold(layout);
      else {
        layout.visible = false;
        layout.folded = false;
        if (layout.hostPage !== "settings") await ctx.persistLayout();
      }
      ctx.hideHostWindow(win);
      if (layout.noteId) ctx.emit("tile-window-closed", layout.noteId);
      // The search panel keeps its renderer warm; business workspaces still
      // release only after the save acknowledgement above. The most recently
      // closed workspace keeps its renderer and plugin backend alive so that
      // re-opening it does not pay a full reload.
      if (layout.label !== "launcher") {
        if (layout.pluginId && !layout.compact) {
          if (retained && retained !== win && !retained.isDestroyed()) retained.destroy();
          retained = win;
        } else win.destroy();
      }
      ctx.capsules.refresh();
      ctx.refreshTray();
    })();
    ctx.releasing.set(win.id, operation);
    void operation.finally(() => ctx.releasing.delete(win.id)).catch(() => {});
    return operation;
  }

  function quit(): Promise<void> {
    return ctx.hostShutdown.request();
  }
  return { prepare, hideAndRelease, foldAndRelease, releaseWindow, quit };
}
