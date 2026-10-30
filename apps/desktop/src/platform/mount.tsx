import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { getConfig } from "../features/settings/api";
import i18n, { initializeI18n } from "../locales";

export async function mountDesktopApp(App: ComponentType) {
  const target = document.getElementById("root");
  if (!target) throw new Error("Missing root element");
  const config = await getConfig().catch(() => undefined);
  await initializeI18n(config?.locale);
  createRoot(target).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  );
}
