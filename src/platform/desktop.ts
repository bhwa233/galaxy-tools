/** Desktop boundary shared by the existing React features; business components never import Electron. */
export type UnlistenFn = () => void;
interface DesktopBridge {
  label: string;
  invoke(
    command: string,
    args?: unknown,
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
  emit(name: string, payload?: unknown): Promise<void>;
  on(name: string, callback: (payload: unknown) => void): UnlistenFn;
  droppedPaths(files: File[]): Promise<string[]>;
}
declare global {
  interface Window {
    spark233Desktop?: DesktopBridge;
  }
}
function bridge(): DesktopBridge {
  if (!window.spark233Desktop) throw new Error("请使用 Electron 桌面入口启动spark233");
  return window.spark233Desktop;
}
export async function invoke<T>(
  command: string,
  args?: unknown,
  options?: { headers?: Record<string, string> },
): Promise<T> {
  const result = await bridge().invoke(
    command,
    options ? { data: args, headers: options.headers } : args,
  );
  if (!result.ok) throw result.error;
  return result.value as T;
}
export async function listen<T = unknown>(
  name: string,
  callback: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return bridge().on(name, (payload) => callback({ payload: payload as T }));
}
export async function emit(name: string, payload?: unknown): Promise<void> {
  await bridge().emit(name, payload);
}
export function getVersion(): Promise<string> {
  return invoke("app_version");
}
export function openUrl(url: string): Promise<void> {
  return invoke("shell_open", { url });
}
export interface DialogOptions {
  directory?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
  title?: string;
}
export function open(options: DialogOptions = {}): Promise<string | string[] | null> {
  return invoke("dialog_open", options);
}
export function save(options: DialogOptions = {}): Promise<string | null> {
  return invoke("dialog_save", options);
}
export function message(text: string, options?: { title?: string; kind?: string }): Promise<void> {
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
function control<T = void>(action: string, value?: unknown): Promise<T> {
  return invoke("window_control", { action, value });
}
export function getCurrentWindow() {
  return {
    label: bridge().label,
    show: () => control("show"),
    setFocus: () => control("focus"),
    hide: () => control("hide"),
    close: () => control("close"),
    minimize: () => control("minimize"),
    toggleMaximize: () => control("toggleMaximize"),
    isMaximized: () => control<boolean>("isMaximized"),
    setAlwaysOnTop: (enabled: boolean) => control("alwaysOnTop", enabled),
    startDragging: () => startPointerOperation(),
    startResizeDragging: (direction: string) => startPointerOperation(direction),
    outerPosition: () => control<{ x: number; y: number }>("position"),
    innerSize: () => control<{ width: number; height: number }>("size"),
    setPosition: (position: PhysicalPosition) => control("setPosition", position),
    setSize: (size: PhysicalSize) => control("setSize", size),
    onResized: (callback: () => void) => listen("window-resized", callback),
    onDragDropEvent: async (
      callback: (event: { payload: { type: "drop"; paths: string[] } }) => void,
    ) => {
      const handler = (event: DragEvent) => {
        if (event.defaultPrevented || !event.dataTransfer?.files.length) return;
        event.preventDefault();
        void bridge()
          .droppedPaths(Array.from(event.dataTransfer.files))
          .then((paths) => callback({ payload: { type: "drop", paths } }));
      };
      const allow = (event: DragEvent) => {
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
  const start = await control<{ x: number; y: number; width: number; height: number }>("bounds");
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
    void control("setBounds", { x, y, width, height }).catch(console.error);
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
  return control("setBounds", bounds);
}
