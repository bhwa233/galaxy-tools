import { useEffect, type ReactNode } from "react";
import { tabToIndentListener } from "indent-textarea";
import "../../App.css";
import { ContextMenuProvider } from "../../components/ContextMenu";
import { ToastContainer } from "../../components/Toast";
import { getConfig } from "../settings/api";
import { applyAccentColor, applyTheme, watchSystemTheme } from "../settings/theme";
import { syncLanguage } from "../../locales";
import { invoke, listen, reportClosePreparation } from "../../platform/desktop";
import { prepareHostWindow } from "./hostPreparation";

export function WindowLifecycle({ prepareClose }: { prepareClose: boolean }) {
  useEffect(() => {
    let active = true;
    const subscription = prepareClose
      ? listen("desktop:prepare-close", ({ payload }) => {
          void prepareHostWindow()
            .then(
              () => reportClosePreparation(payload.requestId, "plugin", "ready"),
              (error) =>
                reportClosePreparation(payload.requestId, "plugin", "failed", String(error)),
            )
            .catch(console.error);
        })
      : Promise.resolve(() => {});
    void subscription
      .then(() => (active ? invoke("desktop_ready") : undefined))
      .catch(console.error);
    return () => {
      active = false;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [prepareClose]);
  return null;
}

/** Shared appearance without any window or plugin routing. */
export function DesktopAppearance() {
  useEffect(() => {
    let active = true;
    let themeCleanup = () => {};
    const apply = (config: Awaited<ReturnType<typeof getConfig>>) => {
      if (!active) return;
      themeCleanup();
      applyTheme(config.theme || "system");
      applyAccentColor(config.accentColor);
      themeCleanup = watchSystemTheme(config.theme || "system");
      document.documentElement.style.setProperty(
        "--tab-indent-size",
        String(config.tabIndentSize ?? 2),
      );
      void syncLanguage(config.locale);
    };
    let changed = false;
    const subscription = listen("config-changed", ({ payload }) => {
      changed = true;
      apply(payload);
    });
    void getConfig()
      .then((config) => {
        if (!changed) apply(config);
      })
      .catch(console.error);
    const tab = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement && event.target.dataset.tabIndent === "true")
        tabToIndentListener(event);
    };
    const altSpace = (event: KeyboardEvent) => {
      if (navigator.userAgent.includes("Windows") && event.altKey && event.code === "Space")
        event.preventDefault();
    };
    document.addEventListener("keydown", tab);
    document.addEventListener("keydown", altSpace);
    return () => {
      active = false;
      themeCleanup();
      void subscription.then((stop) => stop()).catch(() => {});
      document.removeEventListener("keydown", tab);
      document.removeEventListener("keydown", altSpace);
    };
  }, []);
  return null;
}

/** Shared theme, menus and native lifecycle, independent of any plugin page. */
export function DesktopWindow({
  children,
  prepareClose = true,
  transparent = false,
}: {
  children: ReactNode;
  prepareClose?: boolean;
  transparent?: boolean;
}) {
  return (
    <ContextMenuProvider>
      <DesktopAppearance />
      <main
        className={`flex h-screen flex-col overflow-hidden font-body text-foreground ${transparent ? "app-window-shell" : "bg-background"}`}
      >
        {children}
        <WindowLifecycle prepareClose={prepareClose} />
        <ToastContainer />
      </main>
    </ContextMenuProvider>
  );
}
