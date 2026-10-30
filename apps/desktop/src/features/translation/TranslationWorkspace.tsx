import { showToast } from "../../components/Toast";
import { openSettingsWindow } from "../settings/api";
import { useEffect, useRef, useState } from "react";
import { translationTarget } from "../../../../../packages/official/translation/language.mjs";
import { registerHostPreparation } from "../windows/hostPreparation";
import { WorkspaceTitleBar } from "../windows/WorkspaceTitleBar";
import { useTranslation } from "react-i18next";
import { BookOpenIcon, HistoryIcon, LanguagesIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invoke, listen, writeText } from "../../platform/desktop";
import { getTranslationConfiguration, translationAction, watchTranslationChunks } from "./api";
import { DictionaryPane } from "./DictionaryPane";
import { HistoryDrawer } from "./HistoryDrawer";
import { TranslatePane } from "./TranslatePane";
import { useTranslationHistory } from "./useTranslationHistory";
import uiConfiguration from "../../../../../packages/official/translation/config/ui.json";
import type {
  DictionaryEntryResult,
  DictionaryHistory,
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
type WorkspaceView = "dictionary" | "translation" | "search-history";
const navigationIcons = { book: BookOpenIcon, languages: LanguagesIcon, history: HistoryIcon };

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
  const [exporting, setExporting] = useState(false);
  const [config, setConfig] = useState<TranslationConfiguration>();
  const [chunksReady, setChunksReady] = useState(false);
  const [autoLookup, setAutoLookup] = useState(true);
  const [view, setView] = useState<WorkspaceView>(uiConfiguration.defaultView as WorkspaceView);
  const [dictionaryQuery, setDictionaryQuery] = useState("");
  const [dictionaryEntry, setDictionaryEntry] = useState<DictionaryEntryResult>();
  const [dictionaryItems, setDictionaryItems] = useState<DictionaryItem[]>([]);
  const [dictionarySearching, setDictionarySearching] = useState(false);
  const [dictionaryHistory, setDictionaryHistory] = useState<DictionaryHistory["entries"]>([]);
  const [dictionaryHistoryBusy, setDictionaryHistoryBusy] = useState(false);
  const [dictionaryHistoryFailed, setDictionaryHistoryFailed] = useState(false);
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
      setDictionaryItems(next.related ?? []);
      return true;
    }
    if (result?.kind === "dictionary-search" && Array.isArray(result.items)) {
      setDictionaryItems(result.items as DictionaryItem[]);
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
    if (result?.kind === "dictionary-input" && typeof result.query === "string") {
      dictionaryGeneration.current++;
      setDictionarySearching(false);
      setDictionaryEntry(undefined);
      setDictionaryItems([]);
      setDictionaryQuery(result.query);
      setView("dictionary");
      setHistoryOpen(false);
      setError(undefined);
      if (result.query.trim()) void lookup(result.query);
      return;
    }
    resetTranslation();
    dictionaryGeneration.current++;
    setDictionarySearching(false);
    setError(undefined);
    setText("");
    setDictionaryQuery("");
    setDictionaryEntry(undefined);
    setDictionaryItems([]);
    setView(
      result?.kind === "dictionary-entry" || result?.kind === "dictionary-search"
        ? "dictionary"
        : "translation",
    );
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
    setDictionaryEntry(undefined);
    setDictionaryItems([]);
    setError(undefined);
    try {
      const result = (await translationAction({
        action: "search",
        query: word,
        limit: 10,
        recordHistory: true,
      })) as { kind: "dictionary-search"; items: DictionaryItem[] };
      if (mounted.current && generation === dictionaryGeneration.current) {
        setDictionaryEntry(undefined);
        applyDictionary(result);
        if (result?.kind === "dictionary-search" && result.items[0]) {
          const entry = (await translationAction({
            action: "detail",
            id: result.items[0].id,
          })) as DictionaryEntryResult;
          if (
            mounted.current &&
            generation === dictionaryGeneration.current &&
            entry?.kind === "dictionary-entry"
          )
            setDictionaryEntry(entry);
        }
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
      const result = (await translationAction({ action: "detail", id })) as DictionaryEntryResult;
      if (
        mounted.current &&
        generation === dictionaryGeneration.current &&
        result?.kind === "dictionary-entry"
      )
        setDictionaryEntry(result);
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
      setView("dictionary");
      setHistoryOpen(false);
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
    try {
      if (target === "copy") await writeText(content);
      else await invoke("text_action", { target: "notes", text: content });
      if (mounted.current && exportGeneration.current === generation)
        showToast(
          t(target === "copy" ? "notifications.copied" : "notifications.noteSaved"),
          "success",
        );
    } catch (value) {
      if (mounted.current && exportGeneration.current === generation) showToast(errorText(value));
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
    setTranslation({
      kind: "translation",
      requestId: entry.id,
      text: entry.text,
      target: entry.target,
      translatedText: entry.translatedText,
      cached: entry.cached,
      incomplete: entry.incomplete,
    });
    setOverride(entry.target);
    setView("translation");
    setHistoryOpen(false);
  };
  const toggleAutoLookup = () => {
    const next = !autoLookup;
    setAutoLookup(next);
    void translationAction({ action: "preferences_set", autoLookup: next }).catch((value) =>
      showToast(errorText(value)),
    );
  };
  const configure = () => {
    void openSettingsWindow({
      page: "plugins",
      pluginId: "spark233.translation",
      tab: "config",
    }).catch((value) => showToast(errorText(value)));
  };
  const updateDictionaryHistory = async (
    action: "dictionary_history_list" | "dictionary_history_delete" | "dictionary_history_clear",
    query?: string,
  ) => {
    setDictionaryHistoryBusy(true);
    setError(undefined);
    try {
      const result = (await translationAction(
        action === "dictionary_history_delete" ? { action, query: query! } : { action },
      )) as DictionaryHistory;
      if (mounted.current && result?.kind === "dictionary-history") {
        setDictionaryHistory(result.entries);
        setDictionaryHistoryFailed(false);
        if (action !== "dictionary_history_list")
          showToast(
            t(
              action === "dictionary_history_delete"
                ? "notifications.deleted"
                : "notifications.cleared",
            ),
            "success",
          );
      }
    } catch (value) {
      if (mounted.current) {
        if (action === "dictionary_history_list") {
          setError(errorText(value));
          setDictionaryHistoryFailed(true);
        } else showToast(errorText(value));
      }
    } finally {
      if (mounted.current) setDictionaryHistoryBusy(false);
    }
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
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t("translation.title", { defaultValue: "词典与翻译" })}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        void cancel().finally(onClose);
      }}
    >
      <WorkspaceTitleBar
        title={t("translation.title")}
        onClose={() => cancel().finally(onClose)}
        onError={(value) => setError(errorText(value))}
      >
        {view === "translation" ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            title={t("translation.historyTitle")}
            aria-label={t("translation.historyTitle")}
            aria-pressed={historyOpen}
            onClick={() => {
              setHistoryOpen((value) => !value);
              if (!historyOpen) void history.refresh();
            }}
          >
            <HistoryIcon />
          </Button>
        ) : null}
      </WorkspaceTitleBar>
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
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <nav
          aria-label={t("translation.title")}
          className="flex w-32 shrink-0 flex-col gap-1 border-r border-border p-2"
        >
          {uiConfiguration.navigation.map((entry) => {
            const item = entry.id as WorkspaceView;
            const Icon = navigationIcons[entry.icon as keyof typeof navigationIcons];
            return (
              <Button
                key={item}
                type="button"
                aria-pressed={view === item}
                size="sm"
                variant={view === item ? "secondary" : "ghost"}
                className="justify-start"
                onClick={() => {
                  setView(item);
                  setHistoryOpen(false);
                  if (item === "search-history")
                    void updateDictionaryHistory("dictionary_history_list");
                }}
              >
                <Icon />
                {t(entry.label, { defaultValue: entry.label })}
              </Button>
            );
          })}
        </nav>
        {historyOpen && view === "translation" && (
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
        )}
        <TranslatePane
          className={view === "translation" ? "min-w-0 flex-1 p-3" : "hidden"}
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
        {view === "dictionary" && (
          <DictionaryPane
            className="min-w-0 flex-1"
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
          />
        )}
        {view === "search-history" && (
          <section
            className="flex min-w-0 flex-1 flex-col p-3"
            aria-label={t("translation.searchHistory")}
          >
            <div className="flex items-center gap-2 border-b pb-2">
              <h2 className="text-sm font-medium">{t("translation.searchHistory")}</h2>
              <span className="text-xs text-muted-foreground">
                {dictionaryHistory.length} / 100
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={dictionaryHistoryBusy || !dictionaryHistory.length}
                onClick={() => void updateDictionaryHistory("dictionary_history_clear")}
              >
                {t("translation.historyClear")}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {dictionaryHistory.length ? (
                <ul>
                  {dictionaryHistory.map((entry) => (
                    <li key={entry.query} className="flex items-center gap-2 border-b py-1">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate rounded px-2 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setDictionaryQuery(entry.query);
                          setView("dictionary");
                          void lookup(entry.query);
                        }}
                      >
                        {entry.query}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {new Date(entry.at).toLocaleString()}
                      </span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={dictionaryHistoryBusy}
                        title={t("translation.historyDelete")}
                        aria-label={t("translation.historyDelete")}
                        onClick={() =>
                          void updateDictionaryHistory("dictionary_history_delete", entry.query)
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                !dictionaryHistoryBusy &&
                !dictionaryHistoryFailed && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("translation.searchHistoryEmpty")}
                  </p>
                )
              )}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

export default TranslationWorkspace;
