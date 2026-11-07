import { screen } from "electron";
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
    | "windowModes"
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
        // Show-first can reveal a preloaded launcher before its listeners mount.
        // Reconcile actual visibility at readiness so it can start querying;
        // hidden preloads still remain hidden and receive visible:false.
        if (layout.label === "launcher")
          ctx.emit("launcher-visibility-changed", { visible: win.isVisible() }, win);
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
            // A hidden window must not pull itself forward; showing goes through "show".
            if (!win.isVisible()) return;
            win.focus();
            return;
          case "hide":
            await ctx.hideAndRelease(win);
            return;
          case "modeState": {
            const modes = ctx.windowModes.get(win.id);
            return modes
              ? { mode: modes.mode, desktopAvailable: modes.desktopAvailable }
              : { mode: layout.topmost ? "topmost" : "normal", desktopAvailable: false };
          }
          case "mode": {
            const modes = ctx.windowModes.get(win.id);
            if (!modes) throw new AppError("invalidCommand", "此窗口不支持窗口模式");
            if (args.value !== "normal" && args.value !== "topmost" && args.value !== "desktop")
              throw new AppError("invalidPayload", "窗口模式不合法");
            await modes.setMode(args.value);
            return;
          }
          case "close":
            // On the desktop, close means "remove from desktop"; the page stays.
            if (ctx.windowModes.get(win.id)?.mode === "desktop") {
              await ctx.windowModes.get(win.id)!.removeFromDesktop();
              return;
            }
            if (
              layout.label !== "launcher" &&
              ctx.isHostView(layout) &&
              layout.hostPage !== "settings" &&
              !layout.workspace &&
              !layout.pluginId &&
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
            if (!win.isMaximizable()) return;
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
            const value: unknown = args.value;
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new AppError("invalidPayload", "窗口尺寸不合法");
            const entries = Object.entries(value);
            if (
              !entries.length ||
              entries.some(
                ([key, dimension]) =>
                  !["x", "y", "width", "height"].includes(key) ||
                  typeof dimension !== "number" ||
                  !Number.isFinite(dimension) ||
                  Math.abs(dimension) > 100000,
              )
            )
              throw new AppError("invalidPayload", "窗口尺寸不合法");
            win.setBounds(
              keepOnScreen({
                ...win.getBounds(),
                ...Object.fromEntries(
                  entries.map(([key, dimension]) => [key, Math.round(dimension as number)]),
                ),
              }),
            );
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

/** Keep a renderer-requested rectangle usable: no larger than its display and
 * with at least a grab margin on some display, so it cannot cover or vanish. */
function keepOnScreen(bounds: Electron.Rectangle): Electron.Rectangle {
  const margin = 32;
  const area = screen.getDisplayMatching(bounds).bounds;
  const width = Math.max(1, Math.min(bounds.width, area.width));
  const height = Math.max(1, Math.min(bounds.height, area.height));
  const visible = screen
    .getAllDisplays()
    .some(
      ({ bounds: display }) =>
        bounds.x + width - margin >= display.x &&
        bounds.x + margin <= display.x + display.width &&
        bounds.y + height - margin >= display.y &&
        bounds.y + margin <= display.y + display.height,
    );
  if (visible) return { x: bounds.x, y: bounds.y, width, height };
  return {
    x: Math.min(Math.max(bounds.x, area.x - width + margin), area.x + area.width - margin),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - margin),
    width,
    height,
  };
}
