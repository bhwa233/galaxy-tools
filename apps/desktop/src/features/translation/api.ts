import { invoke, listen } from "../../platform/desktop";
import type { TranslationChunk, TranslationConfiguration } from "./types";

export function translationAction(
  parameters: import("../../../shared/desktop-contract").Commands["translation_action"]["args"],
): Promise<unknown> {
  return invoke("translation_action", parameters);
}
export function getTranslationConfiguration(): Promise<TranslationConfiguration> {
  return invoke("translation_action", { action: "config_status" });
}
export function configureTranslation(input: {
  endpoint: string;
  model: string;
  key?: string;
}): Promise<TranslationConfiguration> {
  return invoke("translation_configure", { action: "configure", ...input });
}
export function watchTranslationChunks(
  callback: (chunk: TranslationChunk) => void,
): Promise<() => void> {
  return listen("translation-chunk", (event) => callback(event.payload));
}
