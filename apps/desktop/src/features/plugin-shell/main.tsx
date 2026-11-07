import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { PluginShellState } from "../../../shared/window-mode";
import { StatusBar } from "../windows/StatusBar";
import "../../App.css";

type ShellAction = "minimize" | "toggleMaximize" | "close" | "menu:mode" | "menu:more";
declare global {
  interface Window {
    pluginShell: {
      state(): Promise<PluginShellState>;
      action(name: ShellAction, anchor?: { x: number; y: number }): Promise<void>;
      subscribe(listener: (value: PluginShellState) => void): () => void;
    };
  }
}

/** Host-drawn status bar above a Web plugin page. The page cannot reach it. */
function PluginShell() {
  const [state, setState] = useState<PluginShellState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const receive = (value: PluginShellState) => {
      setState(value);
      document.documentElement.dataset.theme = value.theme.effective;
      document.documentElement.dataset.accent = value.theme.accent || "green";
      document.title = value.title;
    };
    const unsubscribe = window.pluginShell.subscribe(receive);
    void window.pluginShell.state().then(receive);
    return unsubscribe;
  }, []);
  if (!state) return null;
  const action = (name: ShellAction, anchor?: { x: number; y: number }) => {
    setError(undefined);
    void window.pluginShell
      .action(name, anchor)
      .catch((value: unknown) =>
        setError(String(value instanceof Error ? value.message : value).replace(/^Error: /, "")),
      );
  };
  return (
    <div className="h-screen bg-background text-foreground">
      <StatusBar
        title={state.title}
        subtitle={error}
        locale={state.locale}
        runState={error ? "error" : undefined}
        mode={state.mode}
        nativeMenus={{
          mode: (anchor) => action("menu:mode", anchor),
          more: (anchor) => action("menu:more", anchor),
        }}
        maximized={state.maximized}
        maximizable={state.maximizable}
        onMinimize={() => action("minimize")}
        onToggleMaximize={() => action("toggleMaximize")}
        onClose={() => action("close")}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PluginShell />);
