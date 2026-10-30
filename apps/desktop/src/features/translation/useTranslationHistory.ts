import { showToast } from "../../components/Toast";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { translationAction } from "./api";
import type { TranslationHistory, TranslationHistoryEntry, TranslationPreferences } from "./types";

const errorText = (value: unknown) =>
  value instanceof Error
    ? value.message
    : value && typeof value === "object" && "message" in value
      ? String((value as { message: unknown }).message)
      : String(value);

/** History lives in the plugin's private data directory. Every mutation
 * returns the authoritative list so the drawer never guesses at server state. */
export interface TranslationHistoryState {
  entries: TranslationHistoryEntry[];
  enabled: boolean;
  error?: string;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useTranslationHistory(): TranslationHistoryState {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TranslationHistoryEntry[]>([]);
  const [enabled, setEnabledState] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const adopt = useCallback((value: unknown, request: number) => {
    if (request !== generation.current) return;
    if (!value || typeof value !== "object") return;
    const result = value as TranslationHistory;
    if (result.kind !== "translation-history" || !mounted.current) return;
    setEntries(Array.isArray(result.entries) ? result.entries : []);
    setEnabledState(result.enabled !== false);
    setError(undefined);
  }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      adopt(await translationAction({ action: "history_list" }), request);
    } catch (value) {
      if (mounted.current) setError(errorText(value));
    }
  }, [adopt]);
  const remove = useCallback(
    async (id: string) => {
      const request = ++generation.current;
      try {
        adopt(await translationAction({ action: "history_delete", id }), request);
        if (mounted.current) showToast(t("notifications.deleted"), "success");
      } catch (value) {
        if (mounted.current) showToast(errorText(value));
      }
    },
    [adopt, t],
  );
  const clear = useCallback(async () => {
    const request = ++generation.current;
    try {
      adopt(await translationAction({ action: "history_clear" }), request);
      if (mounted.current) showToast(t("notifications.cleared"), "success");
    } catch (value) {
      if (mounted.current) showToast(errorText(value));
    }
  }, [adopt, t]);
  const setEnabled = useCallback(async (next: boolean) => {
    const request = ++generation.current;
    try {
      // Turning history off keeps existing entries; only new translations stop
      // being recorded. The response carries the stored preference, not a list.
      const value = (await translationAction({
        action: "preferences_set",
        historyEnabled: next,
      })) as TranslationPreferences;
      if (
        !mounted.current ||
        request !== generation.current ||
        value?.kind !== "translation-preferences"
      )
        return;
      setEnabledState(value.historyEnabled);
      setError(undefined);
    } catch (value) {
      if (mounted.current) setError(errorText(value));
    }
  }, []);
  return { entries, enabled, error, refresh, remove, clear, setEnabled };
}
