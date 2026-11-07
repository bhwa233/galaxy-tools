import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { WindowTitleBar } from "@spark233/ui/components";
import "../../App.css";

/** Pushed by the host; the plugin page cannot reach this window. */
export interface PluginShellState {
  title: string;
  maximized: boolean;
  maximizable: boolean;
  locale: string;
  theme: { effective: "light" | "dark"; accent?: string };
}
declare global {
  interface Window {
    pluginShell: {
      state(): Promise<PluginShellState>;
      action(name: "minimize" | "toggleMaximize" | "close"): Promise<void>;
      subscribe(listener: (value: PluginShellState) => void): () => void;
    };
  }
}

const LABELS = {
  zh: { minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭" },
  en: { minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
};

/** Host-drawn status bar above a Web plugin page (W1: window controls only). */
function PluginShell() {
  const [state, setState] = useState<PluginShellState>();
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
  const action = (name: "minimize" | "toggleMaximize" | "close") =>
    void window.pluginShell.action(name).catch(console.error);
  return (
    <div className="h-screen bg-background text-foreground">
      <WindowTitleBar
        title={state.title}
        isMaximized={state.maximized}
        maximizable={state.maximizable}
        labels={state.locale.startsWith("en") ? LABELS.en : LABELS.zh}
        onMinimize={() => action("minimize")}
        onToggleMaximize={() => action("toggleMaximize")}
        onClose={() => action("close")}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PluginShell />);
