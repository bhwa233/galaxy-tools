import { AppError } from "../persistence.js";
import type { RuntimeContext } from "../runtime.js";
import { text } from "./arguments.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";
export function createWindowCommands(
  ctx: Pick<
    RuntimeContext,
    | "notesClient"
    | "ready"
    | "emit"
    | "pendingManagerOpen"
    | "windowPresentations"
    | "scheduleLayout"
    | "pending"
    | "preparedWindows"
    | "hideAndRelease"
    | "isHostView"
    | "hostConfig"
    | "quit"
    | "foldAndRelease"
    | "setNotePinned"
    | "applyNoteTopmost"
    | "remember"
    | "publishNoteStates"
    | "workspaceRequests"
  >,
) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    switch (command) {
      case "desktop_ready": {
        ctx.ready.add(win.id);
        // A hotkey may arrive after the preloaded renderer's initial take but
        // before this readiness acknowledgement. Deliver the still-owned handoff.
        const workspace = ctx.workspaceRequests.get(layout.label);
        if (workspace) ctx.emit("open-workspace", workspace, win);
        if (layout.hostPage === "settings" && layout.settingsTarget)
          ctx.emit("settings-navigate", layout.settingsTarget, win);
        if (ctx.pendingManagerOpen?.windowId === win.id) {
          const { payload } = ctx.pendingManagerOpen;
          ctx.pendingManagerOpen = undefined;
          ctx.emit("open-note", payload, win);
        }
        if (layout.visible && !win.isVisible() && (ctx.windowPresentations.get(win)?.() ?? true)) {
          win.show();
          win.focus();
        }
        return;
      }
      case "surface_state": {
        if (layout.view === "main") return;
        // A final save already validated/bound this identity. Its renderer must
        // finish acknowledging the existing surface while public reads are fenced.
        if (args.noteId && layout.noteId !== args.noteId)
          await ctx.notesClient.get(text(args.noteId));
        layout.noteId = args.noteId || undefined;
        layout.view = args.mode === "tile" ? "tile" : "notepad";
        ctx.scheduleLayout();
        return;
      }
      case "desktop_prepare_report": {
        const request = ctx.pending.get(text(args.requestId));
        if (request?.windowId === win.id) {
          if (args.status === "ready") ctx.preparedWindows.add(win.id);
          else ctx.preparedWindows.delete(win.id);
          request.resolve(args.status === "ready");
        }
        return;
      }
      case "window_control": {
        switch (args.action) {
          case "show":
            if (!(ctx.windowPresentations.get(win)?.() ?? true)) return;
            win.show();
            return;
          case "focus":
            if (!(ctx.windowPresentations.get(win)?.() ?? true)) return;
            win.focus();
            return;
          case "hide":
            await ctx.hideAndRelease(win);
            return;
          case "close":
            if (
              layout.label !== "launcher" &&
              ctx.isHostView(layout) &&
              layout.hostPage !== "settings" &&
              !layout.workspace &&
              !layout.compact &&
              !ctx.hostConfig.value.closeToTray
            )
              await ctx.quit();
            else if (ctx.isHostView(layout)) await ctx.hideAndRelease(win);
            else await ctx.foldAndRelease(win);
            return;
          case "minimize":
            win.minimize();
            return;
          case "toggleMaximize":
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
            return;
          case "isMaximized":
            return win.isMaximized();
          case "isAlwaysOnTop":
            return layout.topmost;
          case "alwaysOnTop":
            if (typeof args.value !== "boolean")
              throw new AppError("invalidPayload", "置顶参数不合法");
            if (layout.noteId) ctx.setNotePinned(layout.noteId, args.value);
            else {
              layout.topmost = args.value;
              ctx.applyNoteTopmost(win, layout);
              ctx.remember(win);
              ctx.publishNoteStates();
            }
            return;
          case "bounds":
            return win.getBounds();
          case "position": {
            const [x, y] = win.getPosition();
            return { x, y };
          }
          case "size": {
            const [width, height] = win.getSize();
            return { width, height };
          }
          case "setPosition":
          case "setSize":
          case "setBounds": {
            const current = win.getBounds();
            const value = args.value;
            const entries = Object.entries(value);
            if (
              entries.some(
                ([, dimension]) => !Number.isFinite(dimension) || Math.abs(dimension) > 100000,
              )
            )
              throw new AppError("invalidPayload", "窗口尺寸不合法");
            win.setBounds({
              ...current,
              ...Object.fromEntries(
                entries.map(([key, dimension]) => [key, Math.round(dimension)]),
              ),
            });
            ctx.remember(win);
            return;
          }
        }
        throw new AppError("invalidCommand", "不支持的窗口操作");
      }
    }
    throw new AppError("invalidCommand", "Unsupported host command: " + command);
  }
  return {
    desktop_prepare_report: run,
    desktop_ready: run,
    surface_state: run,
    window_control: run,
  } satisfies Record<string, CommandHandler>;
}
