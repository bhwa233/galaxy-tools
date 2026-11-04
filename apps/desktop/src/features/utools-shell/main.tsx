import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Button, Input, WindowTitleBar } from "@spark233/ui/components";
import { GripHorizontal, Pin, Puzzle, SlidersHorizontal } from "lucide-react";
import { DesktopPanelToolbar } from "../desktop-layer/DesktopPanelToolbar";
import type { UToolsDesktopPresentation } from "../../../shared/utools-desktop";
import "../../App.css";
import "./utools-shell.css";
interface ShellState {
  title: string;
  maximized: boolean;
  theme: { effective: string; accent?: string };
  subInput?: { placeholder: string; value: string; focus?: boolean } | null;
  subInputValue?: string;
  inputFocus?: boolean;
  inputSelect?: boolean;
  list?: Array<{ id: string; title: string; description?: string }> | null;
  error?: string;
  desktopAvailable?: boolean;
  desktop?: UToolsDesktopPresentation | null;
}
declare global {
  interface Window {
    utoolsShell: {
      state(): Promise<ShellState>;
      action(name: string, value?: unknown): Promise<void>;
      subscribe(listener: (value: ShellState) => void): () => void;
    };
  }
}
export function Shell() {
  const [state, setState] = useState<ShellState>({
    title: "uTools 插件",
    maximized: false,
    theme: { effective: "light" },
  });
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listSignature = useRef<string>("");
  const dragging = useRef<number | undefined>(undefined);
  const action = (name: string, value?: unknown) =>
    void window.utoolsShell
      .action(name, value)
      .catch((error) => setState((s) => ({ ...s, error: String(error) })));
  useEffect(() => {
    const receive = (value: ShellState) => {
      setState(value);
      const signature = JSON.stringify(value.list);
      if (signature !== listSignature.current) setSelected(0);
      listSignature.current = signature;
      document.documentElement.dataset.theme = value.theme.effective;
      document.documentElement.dataset.accent = value.theme.accent || "green";
      if (value.subInputValue !== undefined) setText(value.subInputValue);
      else if (value.subInput) setText(value.subInput.value);
    };
    const unsubscribe = window.utoolsShell.subscribe(receive);
    void window.utoolsShell.state().then(receive);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (state.subInput?.focus || state.inputFocus) input.current?.focus();
    if (state.inputSelect) input.current?.select();
    if (state.inputFocus === false) input.current?.blur();
  }, [state.subInput?.focus, state.inputFocus, state.inputSelect]);
  const desktop = state.desktop;
  useLayoutEffect(() => {
    if (desktop) void window.utoolsShell.action("desktop-ready", desktop.revision);
  }, [desktop]);
  const pointer = (
    phase: "start" | "move" | "end" | "cancel",
    event: PointerEvent<HTMLElement>,
  ) => {
    if (phase === "start") {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = event.pointerId;
    } else if (dragging.current !== event.pointerId) return;
    action("desktop-pointer", { phase, pointerId: event.pointerId });
    if (phase === "end" || phase === "cancel") {
      dragging.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return (
    <div
      className={
        desktop
          ? "utools-desktop-frame desktop-overlay-panel text-foreground"
          : "flex h-screen flex-col bg-background text-foreground"
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (desktop?.mode === "overlay") {
            action("desktop-close-overlay");
            return;
          }
          action("hide");
          return;
        }
        if (!state.list?.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelected(
            (i) =>
              (i + (event.key === "ArrowDown" ? 1 : -1) + state.list!.length) % state.list!.length,
          );
        }
        if (event.key === "Enter") {
          event.preventDefault();
          action("select", selected);
        }
      }}
    >
      {desktop ? (
        <DesktopPanelToolbar
          locale={desktop.locale}
          pinned={desktop.card.group === "top"}
          onPin={() =>
            action("desktop-action", { action: "pin", value: desktop.card.group !== "top" })
          }
          onHide={() => action("hide")}
          style={{ left: 0, top: 4, bottom: "auto", width: 280 }}
          onPointerDown={(event) => pointer("start", event)}
          onPointerMove={(event) => pointer("move", event)}
          onPointerUp={(event) => pointer("end", event)}
          onPointerCancel={(event) => pointer("cancel", event)}
          onLostPointerCapture={(event) => {
            if (dragging.current !== undefined) pointer("cancel", event);
          }}
        >
          <Puzzle aria-hidden />
          <span className="desktop-overlay-panel-title">{state.title}</span>
          <GripHorizontal className="desktop-overlay-panel-grip" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="面板设置"
            aria-label="面板设置"
            onClick={() => action("desktop-settings")}
          >
            <SlidersHorizontal />
          </Button>
        </DesktopPanelToolbar>
      ) : (
        <WindowTitleBar
          title={state.title}
          isMaximized={state.maximized}
          labels={{ minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭" }}
          onMinimize={() => action("minimize")}
          onToggleMaximize={() => action("maximize")}
          onClose={() => action("hide")}
        >
          {state.desktopAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="固定到桌面"
              aria-label="固定到桌面"
              onClick={() => action("pin")}
            >
              <Pin />
            </Button>
          )}
        </WindowTitleBar>
      )}
      <div className={desktop ? "utools-desktop-content" : "contents"}>
        {state.subInput && (
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
            <Input
              ref={input}
              value={text}
              placeholder={state.subInput.placeholder || "搜索"}
              aria-label={state.subInput.placeholder || "插件输入"}
              onChange={(event) => {
                setText(event.target.value);
                setSelected(0);
                action("input", event.target.value);
              }}
            />
          </div>
        )}
        {state.error && (
          <div
            className="h-13 shrink-0 overflow-auto border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
            role="alert"
          >
            {state.error}
          </div>
        )}
        {state.list && (
          <div className="flex-1 overflow-auto p-2" role="listbox" aria-label="插件结果">
            {state.list.map((item, index) => (
              <Button
                key={item.id}
                variant={index === selected ? "secondary" : "ghost"}
                className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                role="option"
                aria-selected={index === selected}
                onClick={() => action("select", index)}
              >
                <span>
                  <span className="block">{item.title}</span>
                  {item.description && (
                    <span className="block text-xs text-muted-foreground">{item.description}</span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Shell />);
