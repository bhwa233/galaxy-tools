export interface DictionaryItem {
  id: string;
  title: string;
  description?: string;
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
