import "i18next";
import applications from "../features/applications/locales/zh-CN.json";
import clipboard from "../features/clipboard/locales/zh-CN.json";
import search from "../features/search/locales/zh-CN.json";
import translation from "./zh-CN/translation.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof translation;
      clipboard: typeof clipboard;
      search: typeof search;
      applications: typeof applications;
    };
  }
}
