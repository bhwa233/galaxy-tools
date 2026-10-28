import { openSettingsWindow } from "../settings/api";
import { useEffect, useRef, useState } from "react";
import { translationTarget } from "../../../../../packages/official/translation/language.mjs";
import { registerHostPreparation } from "../windows/hostPreparation";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { invoke, listen, writeText } from "../../platform/desktop";
import { getTranslationConfiguration, translationAction, watchTranslationChunks } from "./api";
import { DictionaryPane } from "./DictionaryPane";
import { HistoryDrawer } from "./HistoryDrawer";
import { TranslatePane } from "./TranslatePane";
import { useTranslationHistory } from "./useTranslationHistory";
import type {
  DictionaryEntryResult,
  DictionaryItem,
  TranslationConfiguration,
  TranslationHistoryEntry,
  TranslationPreferences,
  TranslationResult,
} from "./types";

export interface TranslationWorkspaceProps {
  initialResult?: unknown;
  onClose: () => void;
  notesAvailable: boolean;
  unavailableTargetReason: string;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const errorText = (value: unknown) =>
  value instanceof Error
    ? value.message
    : object(value)?.message
      ? String(object(value)?.message)
      : String(value);
const TARGETS = ["en", "zh-CN"] as const;
type Target = (typeof TARGETS)[number];

/** The workspace never calls a model while typing or looking up a word.
 * Translation is the only networked action; history and dictionary stay local. */
export function TranslationWorkspace({
  initialResult,
  onClose,
  notesAvailable,
  unavailableTargetReason,
}: TranslationWorkspaceProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [translated, setTranslated] = useState("");
  const [translation, setTranslation] = useState<TranslationResult>();
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [override, setOverride] = useState<Target>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [config, setConfig] = useState<TranslationConfiguration>();
  const [chunksReady, setChunksReady] = useState(false);
  const [autoLookup, setAutoLookup] = useState(true);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryQuery, setDictionaryQuery] = useState("");
  const [dictionaryEntry, setDictionaryEntry] = useState<DictionaryEntryResult>();
  const [dictionaryItems, setDictionaryItems] = useState<DictionaryItem[]>([]);
  const [dictionarySearching, setDictionarySearching] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useTranslationHistory();

  const current = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const abortRequested = useRef(false);
  const dictionaryGeneration = useRef(0);
  const exportGeneration = useRef(0);
  const selectionTimer = useRef<number | undefined>(undefined);
  const lastLookup = useRef<string>("");
  const pendingTranslation = useRef<{ id: string; text: string } | undefined>(undefined);
  const lastHandoff = useRef<string | undefined>(undefined);
  const promptedConfiguration = useRef<string | undefined>(undefined);

  useEffect(
    () =>
      registerHostPreparation(async () => {
        const requestId = current.current;
        if (requestId) {
          abortRequested.current = true;
          await translationAction({ action: "cancel", requestId });
        }
      }),
    [],
  );

  useEffect(() => {
    const subscription = listen("plugin-settings-changed", ({ payload }) => {
      if (payload.pluginId === "spark233.translation")
        void getTranslationConfiguration()
          .then(setConfig)
          .catch((value) => setError(errorText(value)));
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, []);

  const resetTranslation = () => {
    pendingTranslation.current = undefined;
    const requestId = current.current;
    current.current = undefined;
    abortRequested.current = true;
    if (requestId) void translationAction({ action: "cancel", requestId }).catch(() => {});
    exportGeneration.current++;
    setBusy(false);
    setExporting(false);
    setTranslated("");
    setTranslation(undefined);
    setCancelled(false);
    setNotice(undefined);
  };

  const applyDictionary = (value: unknown) => {
    const result = object(value);
    if (
      result?.kind === "dictionary-entry" &&
      object(result.entry) &&
      typeof object(result.entry)?.word === "string"
    ) {
      const next = result as unknown as DictionaryEntryResult;
      setDictionaryEntry(next);
      setDictionaryQuery(next.entry.word);
      setText(next.entry.word);
      setDictionaryItems(next.related ?? []);
      setDictionaryOpen(true);
      return true;
    }
    if (result?.kind === "dictionary-search" && Array.isArray(result.items)) {
      setDictionaryItems(result.items as DictionaryItem[]);
      setDictionaryOpen(true);
      return true;
    }
    return false;
  };
  const apply = (value: unknown) => {
    if (applyDictionary(value)) return;
    const result = object(value);
    if (result?.kind === "translation" && typeof result.translatedText === "string") {
      const next = result as unknown as TranslationResult;
      setTranslation(next);
      setTranslated(next.translatedText);
      if (typeof next.text === "string") setText(next.text);
    } else if (typeof result?.text === "string") setText(result.text);
  };

  useEffect(() => {
    // One host window accepts many OCR/clipboard handoffs. A new input revokes
    // every old request identity before replacing the displayed document.
    const result = object(initialResult);
    const requestId =
      typeof result?.translateRequestId === "string" ? result.translateRequestId : undefined;
    if (requestId && requestId === lastHandoff.current) return;
    lastHandoff.current = requestId;
    resetTranslation();
    dictionaryGeneration.current++;
    setDictionarySearching(false);
    setError(undefined);
    setText("");
    setDictionaryQuery("");
    setDictionaryEntry(undefined);
    setDictionaryItems([]);
    setDictionaryOpen(false);
    setOverride(undefined);
    if (result) apply(initialResult);
    if (requestId && typeof result?.text === "string" && result.text.trim())
      pendingTranslation.current = { id: requestId, text: result.text };
    return () => {
      window.clearTimeout(selectionTimer.current);
    };
    // Only a new handoff payload should reset the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialResult]);

  useEffect(() => {
    mounted.current = true;
    let unlisten: (() => void) | undefined;
    let closed = false;
    void getTranslationConfiguration()
      .then((status) => {
        if (!closed) setConfig(status);
      })
      .catch((value: unknown) => {
        if (!closed) setError(errorText(value));
      });
    void translationAction({ action: "preferences_get" })
      .then((value) => {
        const preferences = value as TranslationPreferences;
        if (!closed && preferences?.kind === "translation-preferences")
          setAutoLookup(preferences.autoLookup);
      })
      .catch(() => {});
    void watchTranslationChunks((chunk) => {
      if (
        chunk.requestId !== current.current ||
        typeof chunk.text !== "string" ||
        closed ||
        abortRequested.current
      )
        return;
      setTranslated((previous) => previous + chunk.text);
    })
      .then((stop) => {
        if (closed) stop();
        else {
          unlisten = stop;
          setChunksReady(true);
        }
      })
      .catch((value: unknown) => {
        if (!closed) setError(errorText(value));
      });
    return () => {
      mounted.current = false;
      closed = true;
      unlisten?.();
      dictionaryGeneration.current++;
      if (current.current)
        void translationAction({ action: "cancel", requestId: current.current }).catch(() => {});
    };
  }, []);

  const lookup = async (word: string) => {
    const generation = ++dictionaryGeneration.current;
    lastLookup.current = word;
    setDictionarySearching(true);
    setError(undefined);
    try {
      const result = await translationAction({ action: "search", query: word, limit: 10 });
      if (mounted.current && generation === dictionaryGeneration.current) {
        setDictionaryEntry(undefined);
        applyDictionary(result);
      }
    } catch (value) {
      if (mounted.current && generation === dictionaryGeneration.current)
        setError(errorText(value));
    } finally {
      if (mounted.current && generation === dictionaryGeneration.current)
        setDictionarySearching(false);
    }
  };
  const detail = async (id: string) => {
    const generation = ++dictionaryGeneration.current;
    setDictionarySearching(true);
    setError(undefined);
    try {
      const result = await translationAction({ action: "detail", id });
      if (mounted.current && generation === dictionaryGeneration.current) apply(result);
    } catch (value) {
      if (mounted.current && generation === dictionaryGeneration.current)
        setError(errorText(value));
    } finally {
      if (mounted.current && generation === dictionaryGeneration.current)
        setDictionarySearching(false);
    }
  };
  const lookupSelection = (value: string) => {
    if (!autoLookup) return;
    const candidate = value.trim();
    // A selection reads as a lookup only when it looks like a word or short
    // phrase; dragging across a paragraph must not fire a query.
    if (!candidate || candidate.length > 64 || candidate.includes("\n")) return;
    if (!/\p{L}/u.test(candidate) || candidate === lastLookup.current) return;
    window.clearTimeout(selectionTimer.current);
    selectionTimer.current = window.setTimeout(() => {
      setDictionaryQuery(candidate);
      void lookup(candidate);
    }, 250);
  };

  const translate = async (
    explicit?: Target,
    sourceText = text,
    requestId: string = crypto.randomUUID(),
  ) => {
    if (current.current || !sourceText.trim()) return;
    pendingTranslation.current = undefined;
    if (sourceText.length > 20000) {
      setError(t("translation.tooLong"));
      return;
    }
    current.current = requestId;
    abortRequested.current = false;
    setBusy(true);
    setError(undefined);
    setCancelled(false);
    setNotice(undefined);
    setTranslated("");
    setTranslation(undefined);
    const target = explicit ?? override;
    try {
      const result = await translationAction({
        action: "translate",
        text: sourceText,
        requestId,
        ...(target ? { target } : {}),
      });
      if (mounted.current && current.current === requestId && !abortRequested.current) {
        apply(result);
        void history.refresh();
      }
    } catch (value) {
      if (mounted.current && current.current === requestId && !abortRequested.current)
        setError(errorText(value));
    } finally {
      if (current.current === requestId) {
        current.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const cancel = async () => {
    const requestId = current.current;
    if (!requestId) return;
    abortRequested.current = true;
    setCancelled(true);
    try {
      await translationAction({ action: "cancel", requestId });
    } catch (value) {
      if (current.current !== requestId) return;
      abortRequested.current = false;
      setCancelled(false);
      setError(errorText(value));
    }
  };

  const exportResult = async (target: "copy" | "notes", content = translated) => {
    if (target === "notes" && !notesAvailable) {
      setError(unavailableTargetReason);
      return;
    }
    if (!content || busy || exporting) return;
    const generation = ++exportGeneration.current;
    setExporting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (target === "copy") await writeText(content);
      else await invoke("text_action", { target: "notes", text: content });
      if (mounted.current && exportGeneration.current === generation)
        setNotice(target === "copy" ? t("markdown.copied") : t("translation.noteSaved"));
    } catch (value) {
      if (mounted.current && exportGeneration.current === generation) setError(errorText(value));
    } finally {
      if (mounted.current && exportGeneration.current === generation) setExporting(false);
    }
  };

  const automatic = translationTarget(text);
  const direction = override ?? automatic;
  const flip = () => setOverride(direction === "en" ? "zh-CN" : "en");
  const clear = () => {
    resetTranslation();
    setText("");
    setOverride(undefined);
  };
  const selectHistory = (entry: TranslationHistoryEntry) => {
    resetTranslation();
    setText(entry.text);
    setTranslated(entry.translatedText);
    setOverride(entry.target);
  };
  const toggleAutoLookup = () => {
    const next = !autoLookup;
    setAutoLookup(next);
    void translationAction({ action: "preferences_set", autoLookup: next }).catch((value) =>
      setError(errorText(value)),
    );
  };
  const configure = () => {
    void openSettingsWindow({
      page: "plugins",
      pluginId: "spark233.translation",
      tab: "config",
    }).catch((value) => setError(errorText(value)));
  };

  useEffect(() => {
    const pending = pendingTranslation.current;
    if (!pending || !config || !chunksReady) return;
    if (!config.configured) {
      if (promptedConfiguration.current !== pending.id) {
        promptedConfiguration.current = pending.id;
        configure();
      }
      return;
    }
    // Consume before dispatch so duplicate handoffs/config notifications cannot
    // repeat a paid request. Edits/history/new input revoke the pending intent.
    pendingTranslation.current = undefined;
    void translate(translationTarget(pending.text), pending.text, pending.id);
    // Network execution follows only a new explicit handoff or service readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialResult, config, chunksReady]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2 p-3"
      aria-label={t("translation.title", { defaultValue: "词典与翻译" })}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        void cancel().finally(onClose);
      }}
    >
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label={t("translation.dismiss", { defaultValue: "关闭提示" })}
            onClick={() => setError(undefined)}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 gap-3 overflow-hidden">
        <HistoryDrawer
          open={historyOpen}
          entries={history.entries}
          enabled={history.enabled}
          onToggle={() => {
            setHistoryOpen((value) => !value);
            if (!historyOpen) void history.refresh();
          }}
          onSelect={selectHistory}
          onDelete={(id) => void history.remove(id)}
          onClear={() => void history.clear()}
          onToggleEnabled={(enabled) => void history.setEnabled(enabled)}
        />
        <TranslatePane
          className="min-w-0 flex-1"
          text={text}
          translated={translated}
          translation={translation}
          busy={busy}
          cancelled={cancelled}
          exporting={exporting}
          configured={!!config?.configured}
          target={automatic}
          override={override}
          notesAvailable={notesAvailable}
          unavailableTargetReason={unavailableTargetReason}
          onTextChange={(value) => {
            resetTranslation();
            setText(value);
            setOverride(undefined);
          }}
          onTranslate={translate}
          onCancel={() => void cancel()}
          onFlip={flip}
          onClearOverride={() => setOverride(undefined)}
          onClear={clear}
          onCopy={() => void exportResult("copy")}
          onSaveNote={() => void exportResult("notes")}
          onConfigure={configure}
          onLookupSelection={lookupSelection}
        />
        {dictionaryOpen && (
          <DictionaryPane
            className="w-[340px] shrink-0 max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-10 max-[900px]:w-[300px]"
            query={dictionaryQuery}
            entry={dictionaryEntry}
            items={dictionaryItems}
            searching={dictionarySearching}
            exporting={exporting}
            autoLookup={autoLookup}
            notesAvailable={notesAvailable}
            unavailableTargetReason={unavailableTargetReason}
            onQueryChange={setDictionaryQuery}
            onSearch={() => void lookup(dictionaryQuery)}
            onDetail={(id) => void detail(id)}
            onToggleAutoLookup={toggleAutoLookup}
            onCopyEntry={(content) => void exportResult("copy", content)}
            onSaveEntry={(content) => void exportResult("notes", content)}
            onClose={() => setDictionaryOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

export default TranslationWorkspace;
