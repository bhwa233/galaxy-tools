import enUS from "./en-US/translation.json";
import zhCN from "./zh-CN/translation.json";
import clipboardZhCN from "../features/clipboard/locales/zh-CN.json";
import clipboardEnUS from "../features/clipboard/locales/en-US.json";
import searchZhCN from "../features/search/locales/zh-CN.json";
import searchEnUS from "../features/search/locales/en-US.json";
import applicationsZhCN from "../features/applications/locales/zh-CN.json";
import applicationsEnUS from "../features/applications/locales/en-US.json";

export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

function isTranslationTree(value: string | TranslationTree | undefined): value is TranslationTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeTranslations(source: TranslationTree, overrides: TranslationTree): TranslationTree {
  const merged: TranslationTree = { ...source };

  for (const [key, value] of Object.entries(overrides)) {
    const sourceValue = merged[key];

    if (isTranslationTree(sourceValue) && isTranslationTree(value)) {
      merged[key] = mergeTranslations(sourceValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export const translationOverrides = {
  "zh-CN": zhCN,
  "en-US": enUS,
} as const satisfies Record<string, TranslationTree>;

export const resolvedTranslations = {
  "zh-CN": translationOverrides["zh-CN"],
  "en-US": mergeTranslations(translationOverrides["zh-CN"], translationOverrides["en-US"]),
} as const;

export const resources = {
  "zh-CN": {
    translation: resolvedTranslations["zh-CN"],
    clipboard: clipboardZhCN,
    search: searchZhCN,
    applications: applicationsZhCN,
  },
  "en-US": {
    translation: resolvedTranslations["en-US"],
    clipboard: clipboardEnUS,
    search: searchEnUS,
    applications: applicationsEnUS,
  },
} as const;
