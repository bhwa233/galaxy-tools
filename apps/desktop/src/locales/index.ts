import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, resolveAppLocale, SUPPORTED_LOCALES } from "./locale-whitelist";
import { resources } from "./resources";

let initPromise: Promise<typeof i18n> | null = null;
let currentResources = resources;

if (import.meta.hot) {
  import.meta.hot.accept("./resources", async (updated) => {
    if (!updated || !("resources" in updated)) return;
    currentResources = updated.resources as typeof resources;
    if (initPromise) await initPromise;
    if (!i18n.isInitialized) return;
    for (const [locale, namespaces] of Object.entries(currentResources)) {
      for (const [namespace, bundle] of Object.entries(namespaces)) {
        i18n.removeResourceBundle(locale, namespace);
        i18n.addResourceBundle(locale, namespace, bundle);
      }
    }
    // React's translation hooks subscribe to language changes. Reapply the
    // current language after replacing bundles, keeping mounted editors intact.
    await i18n.changeLanguage(i18n.resolvedLanguage ?? i18n.language);
  });
}

function browserLocale(): string | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }

  return navigator.language;
}

export function initializeI18n(preferredLocale?: string | null) {
  if (!initPromise) {
    initPromise = i18n
      .use(initReactI18next)
      .init({
        resources: currentResources,
        lng: resolveAppLocale(preferredLocale, browserLocale()),
        fallbackLng: DEFAULT_LOCALE,
        supportedLngs: [...SUPPORTED_LOCALES],
        defaultNS: "translation",
        ns: ["translation", "clipboard", "search", "applications"],
        interpolation: {
          escapeValue: false,
        },
        returnEmptyString: false,
        returnNull: false,
      })
      .then(() => {
        if (typeof document !== "undefined")
          document.documentElement.lang = i18n.resolvedLanguage ?? DEFAULT_LOCALE;
        return i18n;
      });
  }

  return initPromise;
}

export async function syncLanguage(locale?: string | null) {
  const nextLocale = resolveAppLocale(locale, browserLocale());

  if (!i18n.isInitialized) {
    await initializeI18n(nextLocale);
    return i18n;
  }

  if (i18n.resolvedLanguage !== nextLocale && i18n.language !== nextLocale) {
    await i18n.changeLanguage(nextLocale);
  }
  if (typeof document !== "undefined") document.documentElement.lang = nextLocale;

  return i18n;
}

export { i18n };

export default i18n;
