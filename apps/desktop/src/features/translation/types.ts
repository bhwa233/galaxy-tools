export interface DictionaryItem {
  id: string;
  title: string;
  description?: string;
}
export interface DictionaryHistory {
  kind: "dictionary-history";
  entries: { query: string; at: string }[];
}
export interface DictionaryEntryResult {
  kind: "dictionary-entry";
  entry: {
    id: string;
    word: string;
    phonetic: string;
    translation: string;
    definition: string;
    pos: string;
    tags: string;
    exchange: string;
  };
  related: DictionaryItem[];
}
export interface TranslationResult {
  kind: "translation";
  requestId: string;
  text: string;
  target: "en" | "zh-CN";
  translatedText: string;
  cached: boolean;
  cacheSaved?: boolean;
  historySaved?: boolean;
  incomplete?: boolean;
}
export interface TranslationConfiguration {
  kind: "translation-config";
  configured: boolean;
  endpoint: string;
  model: string;
  hasKey: boolean;
}
export interface TranslationChunk {
  requestId: string;
  text: string;
  done?: boolean;
}
export type TranslationSource = "workspace" | "ocr" | "clipboard" | "launcher";
export interface TranslationHistoryEntry {
  id: string;
  at: string;
  target: "en" | "zh-CN";
  text: string;
  translatedText: string;
  model: string;
  cached: boolean;
  source: TranslationSource;
  incomplete?: boolean;
}
export interface TranslationHistory {
  kind: "translation-history";
  entries: TranslationHistoryEntry[];
  enabled: boolean;
}
export interface TranslationPreferences {
  kind: "translation-preferences";
  autoLookup: boolean;
  historyEnabled: boolean;
}
