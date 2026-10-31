/** Desktop boundary shared by the existing React features; business components never import Electron. */
import type { CommandName } from "../../shared/command-policies.js";
import type {
  CommandInput,
  CommandResult,
  Commands,
  DesktopBridge,
  DialogOptions,
  Events,
  UnlistenFn,
} from "../../shared/desktop-contract.js";
import type { CustomApplicationTarget } from "../features/applications/types";
export type { DialogOptions, UnlistenFn } from "../../shared/desktop-contract.js";

declare global {
  interface Window {
    spark233Desktop?: DesktopBridge;
  }
}
function bridge(): DesktopBridge {
  if (!window.spark233Desktop) throw new Error("请使用 Electron 桌面入口启动spark233");
  return window.spark233Desktop;
}
export async function invoke<
  C extends CommandName,
  const A extends Commands[C]["args"] = Commands[C]["args"],
>(command: C, ...input: CommandInput<C, A>): Promise<CommandResult<C, A>> {
  const result = await bridge().invoke<C, A>(command, ...input);
  if (!result.ok) throw result.error;
  return result.value;
}
export const invokeCommand = invoke;
export async function listen<E extends keyof Events>(
  name: E,
  callback: (event: { payload: Events[E] }) => void,
): Promise<UnlistenFn> {
  return bridge().on(name, (payload) => callback({ payload }));
}
export async function emit<E extends keyof Events>(name: E, payload?: Events[E]): Promise<void> {
  await bridge().emit(name, payload);
}
export function droppedPaths(files: File[]): Promise<string[]> {
  return bridge().droppedPaths(files);
}
export function droppedApplicationEntries(files: File[]): Promise<CustomApplicationTarget[]> {
  return bridge().droppedApplicationEntries(files);
}
export function getVersion(): Promise<string> {
  return invoke("app_version");
}
export function openUrl(url: string): Promise<void> {
  return invoke("shell_open", { url });
}
export function open(options: DialogOptions = {}): Promise<string | string[] | null> {
  return invoke("dialog_open", options);
}
export function save(options: DialogOptions = {}): Promise<string | null> {
  return invoke("dialog_save", options);
}
export function message(
  text: string,
  options?: { title?: string; kind?: "info" | "warning" | "error" | "question" },
): Promise<void> {
  return invoke("dialog_message", { text, ...options });
}
export function readText(): Promise<string> {
  return invoke("clipboard_read");
}
export function writeText(text: string): Promise<void> {
  return invoke("clipboard_write", { text });
}
export function convertFileSrc(path: string): string {
  return `spark233://asset/${encodeURIComponent(path)}`;
}
export class PhysicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
export class PhysicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}
export function getCurrentWindow() {
  return {
    label: bridge().label,
    show: () => invoke("window_control", { action: "show" }),
    setFocus: () => invoke("window_control", { action: "focus" }),
    hide: () => invoke("window_control", { action: "hide" }),
    close: () => invoke("window_control", { action: "close" }),
    minimize: () => invoke("window_control", { action: "minimize" }),
    toggleMaximize: () => invoke("window_control", { action: "toggleMaximize" }),
    isMaximized: () => invoke("window_control", { action: "isMaximized" }),
    setAlwaysOnTop: (enabled: boolean) =>
      invoke("window_control", { action: "alwaysOnTop", value: enabled }),
    startDragging: () => startPointerOperation(),
    startResizeDragging: (direction: string) => startPointerOperation(direction),
    outerPosition: () => invoke("window_control", { action: "position" }),
    innerSize: () => invoke("window_control", { action: "size" }),
    setPosition: (position: PhysicalPosition) =>
      invoke("window_control", { action: "setPosition", value: position }),
    setSize: (size: PhysicalSize) => invoke("window_control", { action: "setSize", value: size }),
    onResized: (callback: () => void) => listen("window-resized", callback),
    onDragDropEvent: async (
      callback: (event: { payload: { type: "drop"; paths: string[] } }) => void,
    ) => {
      const handler = (event: DragEvent) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-application-entry-drop]")
        )
          return;
        if (event.defaultPrevented || !event.dataTransfer?.files.length) return;
        event.preventDefault();
        void bridge()
          .droppedPaths(Array.from(event.dataTransfer.files))
          .then((paths) => callback({ payload: { type: "drop", paths } }))
          .catch((error) => console.error("file-drop", error));
      };
      const allow = (event: DragEvent) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-application-entry-drop]")
        )
          return;
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      };
      document.addEventListener("dragover", allow);
      document.addEventListener("drop", handler);
      return () => {
        document.removeEventListener("drop", handler);
        document.removeEventListener("dragover", allow);
      };
    },
  };
}

export interface ClosePrepareRequest {
  requestId: string;
}
export function reportClosePreparation(
  requestId: string,
  _windowLabel: string,
  status: "ready" | "failed",
  message?: string,
): Promise<void> {
  return invoke("desktop_prepare_report", { requestId, status, message });
}

let lastPointer: { id: number; x: number; y: number; target: Element } | undefined;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 0 && event.target instanceof Element)
        lastPointer = {
          id: event.pointerId,
          x: event.screenX,
          y: event.screenY,
          target: event.target,
        };
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    () => {
      lastPointer = undefined;
    },
    true,
  );
  window.addEventListener(
    "pointercancel",
    () => {
      lastPointer = undefined;
    },
    true,
  );
}
/** Native title bars use app-region. Editable tile bodies and resize grips use captured pointers. */
export async function startPointerOperation(direction?: string): Promise<void> {
  const pointer = lastPointer;
  if (!pointer) return;
  pointer.target.setPointerCapture(pointer.id);
  const start = await invoke("window_control", { action: "bounds" });
  if (lastPointer !== pointer) return;
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer.id || !(event.buttons & 1)) return;
    const dx = event.screenX - pointer.x,
      dy = event.screenY - pointer.y;
    let { x, y, width, height } = start;
    if (!direction) {
      x += dx;
      y += dy;
    } else {
      if (direction.includes("East")) width = Math.max(160, width + dx);
      if (direction.includes("South")) height = Math.max(60, height + dy);
      if (direction.includes("West")) {
        width = Math.max(160, width - dx);
        x += start.width - width;
      }
      if (direction.includes("North")) {
        height = Math.max(60, height - dy);
        y += start.height - height;
      }
    }
    void invoke("window_control", { action: "setBounds", value: { x, y, width, height } }).catch(
      console.error,
    );
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    pointer.target.removeEventListener("lostpointercapture", end);
    if (pointer.target.hasPointerCapture(pointer.id))
      pointer.target.releasePointerCapture(pointer.id);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  pointer.target.addEventListener("lostpointercapture", end);
}
export function setWindowBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<void> {
  return invoke("window_control", { action: "setBounds", value: bounds });
}
