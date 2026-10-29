import { tabToIndentListener } from "indent-textarea";
import { lazy, Suspense, useEffect } from "react";
import "./App.css";
import { ContextMenuProvider } from "./components/ContextMenu";
import { ToastContainer } from "./components/Toast";
import { Spinner } from "./components/ui/spinner";
import { getConfig } from "./features/settings/api";
import { applyTheme, watchSystemTheme } from "./features/settings/theme";
import type { ThemeOption } from "./features/settings/types";
import { prepareHostWindow } from "./features/windows/hostPreparation";
import { getInitialRoute, type AppView } from "./features/windows/windowRoutes";
import { syncLanguage } from "./locales";
import { invoke, listen, reportClosePreparation } from "./platform/desktop";

const Launcher = lazy(() =>
  import("./features/launcher/Launcher").then((module) => ({ default: module.Launcher })),
);
const MainWindow = lazy(() =>
  import("./features/notes/MainWindow").then((module) => ({ default: module.MainWindow })),
);
const NotePad = lazy(() =>
  import("./features/notes/NotePad").then((module) => ({ default: module.NotePad })),
);
const SettingsWindow = lazy(() =>
  import("./features/settings/SettingsWindow").then((module) => ({
    default: module.SettingsWindow,
  })),
);
const CapsuleHost = lazy(() =>
  import("./features/capsules/CapsuleHost").then((module) => ({ default: module.CapsuleHost })),
);
const TileShowcase = lazy(() =>
  import("./components/TileShowcase").then((module) => ({ default: module.TileShowcase })),
);

// This commits with the selected lazy view, so desktop_ready cannot reveal a
// blank window before the page has loaded and its save handlers have mounted.
function WindowLifecycle({ activeView }: { activeView: AppView }) {
  useEffect(() => {
    const subscription =
      activeView === "launcher" || activeView === "settings"
        ? listen("desktop:prepare-close", (event) => {
            void prepareHostWindow()
              .then(
                () => reportClosePreparation(event.payload.requestId, activeView, "ready"),
                (error) =>
                  reportClosePreparation(
                    event.payload.requestId,
                    activeView,
                    "failed",
                    String(error),
                  ),
              )
              .catch(console.error);
          })
        : Promise.resolve(() => {});
    void subscription.then(() => invoke("desktop_ready")).catch(console.error);
    return () => {
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [activeView]);
  return null;
}

function App() {
  const route = getInitialRoute();
  const activeView = route.view;

  useEffect(() => {
    let cleanup = () => {};
    getConfig()
      .then((config) => {
        const theme = (config.theme || "system") as ThemeOption;
        applyTheme(theme);
        cleanup = watchSystemTheme(theme);
        document.documentElement.style.setProperty(
          "--tab-indent-size",
          String(config.tabIndentSize ?? 2),
        );
        void syncLanguage(config.locale);
      })
      .catch(() => {});
    return () => cleanup();
  }, []);

  useEffect(() => {
    let themeCleanup = () => {};
    const unlisten = listen("config-changed", (event) => {
      const theme = (event.payload.theme || "system") as ThemeOption;
      applyTheme(theme);
      themeCleanup();
      themeCleanup = watchSystemTheme(theme);
      document.documentElement.style.setProperty(
        "--tab-indent-size",
        String(event.payload.tabIndentSize ?? 2),
      );
      void syncLanguage(event.payload.locale);
    });
    return () => {
      themeCleanup();
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const handleTab = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (target.dataset.tabIndent !== "true") return;
      tabToIndentListener(event);
    };
    window.addEventListener("keydown", handleTab, true);
    return () => window.removeEventListener("keydown", handleTab, true);
  }, []);

  useEffect(() => {
    const isWindows =
      navigator.userAgent.includes("Windows") || navigator.platform.toLowerCase().startsWith("win");
    if (!isWindows) return;

    const preventSystemMenu = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "Space") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", preventSystemMenu, true);
    return () => document.removeEventListener("keydown", preventSystemMenu, true);
  }, []);

  const loading = (
    <div className="flex h-screen items-center justify-center bg-background">
      <Spinner />
    </div>
  );
  if (activeView === "capsule")
    return (
      <Suspense fallback={loading}>
        <CapsuleHost />
        <WindowLifecycle activeView={activeView} />
      </Suspense>
    );

  return (
    <ContextMenuProvider>
      <div className="app-window-shell h-screen font-body text-ink overflow-hidden">
        <Suspense fallback={loading}>
          {activeView === "settings" ? (
            <SettingsWindow />
          ) : activeView === "launcher" ? (
            <Launcher />
          ) : activeView === "main" ? (
            <MainWindow />
          ) : activeView === "notepad" ? (
            <NotePad initialNoteId={route.noteId} />
          ) : (
            <TileShowcase noteId={route.noteId} />
          )}
          <WindowLifecycle activeView={activeView} />
        </Suspense>
        <ToastContainer />
      </div>
    </ContextMenuProvider>
  );
}

export default App;
