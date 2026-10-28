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
  const [entries, setEntries] = useState<TranslationHistoryEntry[]>([]);
  const [enabled, setEnabledState] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const adopt = useCallback((value: unknown) => {
    if (!value || typeof value !== "object") return;
    const result = value as TranslationHistory;
    if (result.kind !== "translation-history" || !mounted.current) return;
    setEntries(Array.isArray(result.entries) ? result.entries : []);
    setEnabledState(result.enabled !== false);
    setError(undefined);
  }, []);
  const refresh = useCallback(async () => {
    try {
      adopt(await translationAction({ action: "history_list" }));
    } catch (value) {
      if (mounted.current) setError(errorText(value));
    }
  }, [adopt]);
  const remove = useCallback(
    async (id: string) => {
      try {
        adopt(await translationAction({ action: "history_delete", id }));
      } catch (value) {
        if (mounted.current) setError(errorText(value));
      }
    },
    [adopt],
  );
  const clear = useCallback(async () => {
    try {
      adopt(await translationAction({ action: "history_clear" }));
    } catch (value) {
      if (mounted.current) setError(errorText(value));
    }
  }, [adopt]);
  const setEnabled = useCallback(async (next: boolean) => {
    try {
      // Turning history off keeps existing entries; only new translations stop
      // being recorded. The response carries the stored preference, not a list.
      const value = (await translationAction({
        action: "preferences_set",
        historyEnabled: next,
      })) as TranslationPreferences;
      if (!mounted.current || value?.kind !== "translation-preferences") return;
      setEnabledState(value.historyEnabled);
      setError(undefined);
    } catch (value) {
      if (mounted.current) setError(errorText(value));
    }
  }, []);
  return { entries, enabled, error, refresh, remove, clear, setEnabled };
}
