import { Component, StrictMode, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import i18n, { initializeI18n } from "../locales";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { WindowLifecycle } from "../features/windows/DesktopWindow";
import { getCurrentWindow } from "./desktop";

export function ShellFallback({ error }: { error?: Error }) {
  const { t } = useTranslation();
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
      <Alert variant={error ? "destructive" : "default"}>
        {!error && <Spinner />}
        <AlertTitle>{t(error ? "shell.loadFailed" : "shell.loading")}</AlertTitle>
        {error && <AlertDescription>{error.message}</AlertDescription>}
      </Alert>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("launcher.retry")}
        </Button>
        <Button
          variant="outline"
          onClick={() => void getCurrentWindow().close().catch(console.error)}
        >
          {t("shell.close")}
        </Button>
      </div>
      <WindowLifecycle prepareClose />
    </main>
  );
}

// The existing card boundary reports card faults; host page/lazy-load failures
// need recovery and native close controls outside the failed page instead.
class HostPageBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("host-page", error);
  }
  render() {
    return this.state.error ? <ShellFallback error={this.state.error} /> : this.props.children;
  }
}

export async function mountDesktopApp(App: ComponentType) {
  const target = document.getElementById("root");
  if (!target) throw new Error("Missing root element");
  // Appearance applies the saved locale after mount. A pending config IPC must
  // never keep the shell (including its close controls) from rendering.
  await initializeI18n();
  const root = createRoot(target);
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <HostPageBoundary>
          <App />
        </HostPageBoundary>
      </I18nextProvider>
    </StrictMode>,
  );
  return root;
}
