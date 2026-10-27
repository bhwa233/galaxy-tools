import { openSettingsWindow } from "../settings/api";
import { useEffect, useRef, useState } from "react";
import { translationTarget } from "../../../packages/official/translation/language.mjs";
import { registerHostPreparation } from "../windows/hostPreparation";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { invoke, listen, writeText } from "../../platform/desktop";
import { getTranslationConfiguration, translationAction, watchTranslationChunks } from "./api";
import type {
  DictionaryEntryResult,
  DictionaryItem,
  TranslationConfiguration,
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

/** The local workspace never calls a model while typing or looking up a word.
 * All operations cross the host's enabled-plugin and configuration boundary. */
export function TranslationWorkspace({
  initialResult,
  onClose,
  notesAvailable,
  unavailableTargetReason,
}: TranslationWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DictionaryItem[]>([]);
  const [entry, setEntry] = useState<DictionaryEntryResult>();
  const [translated, setTranslated] = useState("");
  const [translation, setTranslation] = useState<TranslationResult>();
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const saving = false;
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [config, setConfig] = useState<TranslationConfiguration>();
  const current = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
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
  const abortRequested = useRef(false);
  const queryGeneration = useRef(0);
  const exportGeneration = useRef(0);

  useEffect(() => {
    const subscription = listen<{ pluginId: string }>("plugin-settings-changed", ({ payload }) => {
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

  const apply = (value: unknown) => {
    const result = object(value);
    if (
      result?.kind === "dictionary-entry" &&
      object(result.entry) &&
      typeof object(result.entry)?.word === "string"
    ) {
      const next = result as unknown as DictionaryEntryResult;
      setEntry(next);
      setQuery(next.entry.word);
      setText(next.entry.word);
      setItems(next.related ?? []);
    } else if (result?.kind === "dictionary-search" && Array.isArray(result.items))
      setItems(result.items as DictionaryItem[]);
    else if (result?.kind === "translation" && typeof result.translatedText === "string") {
      const next = result as unknown as TranslationResult;
      setTranslation(next);
      setTranslated(next.translatedText);
      if (typeof next.text === "string") setText(next.text);
    } else if (typeof result?.text === "string") setText(result.text);
  };
  useEffect(() => {
    // One host window accepts many OCR/clipboard handoffs. A new input revokes
    // every old request identity before replacing the displayed document.
    resetTranslation();
    queryGeneration.current++;
    setSearching(false);
    setError(undefined);
    setText("");
    setQuery("");
    setEntry(undefined);
    setItems([]);
    apply(initialResult);
  }, [initialResult]);
  useEffect(() => {
    mounted.current = true;
    let unlisten: (() => void) | undefined;
    let closed = false;
    void getTranslationConfiguration()
      .then((status) => {
        if (!closed) {
          setConfig(status);
        }
      })
      .catch((value: unknown) => {
        if (!closed) setError(errorText(value));
      });
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
        else unlisten = stop;
      })
      .catch((value: unknown) => {
        if (!closed) setError(errorText(value));
      });
    return () => {
      mounted.current = false;
      closed = true;
      unlisten?.();
      queryGeneration.current++;
      if (current.current)
        void translationAction({ action: "cancel", requestId: current.current }).catch(() => {});
    };
  }, []);

  const search = async () => {
    const generation = ++queryGeneration.current;
    setSearching(true);
    setError(undefined);
    try {
      const result = await translationAction({ action: "search", query, limit: 10 });
      if (mounted.current && generation === queryGeneration.current) {
        setEntry(undefined);
        apply(result);
      }
    } catch (value) {
      if (mounted.current && generation === queryGeneration.current) setError(errorText(value));
    } finally {
      if (mounted.current && generation === queryGeneration.current) setSearching(false);
    }
  };
  const detail = async (id: string) => {
    const generation = ++queryGeneration.current;
    setSearching(true);
    setError(undefined);
    try {
      const result = await translationAction({ action: "detail", id });
      if (mounted.current && generation === queryGeneration.current) {
        resetTranslation();
        apply(result);
      }
    } catch (value) {
      if (mounted.current && generation === queryGeneration.current) setError(errorText(value));
    } finally {
      if (mounted.current && generation === queryGeneration.current) setSearching(false);
    }
  };
  const translate = async (target?: "en" | "zh-CN") => {
    if (current.current || !text.trim()) return;
    const requestId = crypto.randomUUID();
    current.current = requestId;
    abortRequested.current = false;
    setBusy(true);
    setError(undefined);
    setCancelled(false);
    setNotice(undefined);
    setTranslated("");
    setTranslation(undefined);
    try {
      const result = await translationAction({
        action: "translate",
        text,
        requestId,
        ...(target ? { target } : {}),
      });
      if (mounted.current && current.current === requestId && !abortRequested.current)
        apply(result);
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
        setNotice(
          target === "copy"
            ? t("markdown.copied")
            : t("translation.noteSaved", {
                defaultValue: i18n.resolvedLanguage?.startsWith("en")
                  ? "Saved as a note"
                  : "已保存为便签",
              }),
        );
    } catch (value) {
      if (mounted.current && exportGeneration.current === generation) setError(errorText(value));
    } finally {
      if (mounted.current && exportGeneration.current === generation) setExporting(false);
    }
  };
  const defaultEnglish = translationTarget(text) === "en";
  const dictionaryText = entry
    ? [
        entry.entry.word,
        entry.entry.phonetic ? `/${entry.entry.phonetic}/` : "",
        entry.entry.translation,
        entry.entry.definition,
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      aria-label={t("translation.title", { defaultValue: "词典与翻译" })}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium">
          {t("translation.title", { defaultValue: "词典与翻译" })}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void cancel().finally(onClose);
          }}
        >
          {t("translation.close", { defaultValue: "返回启动器" })}
        </Button>
      </header>
      {!notesAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailableTargetReason}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("translation.error", { defaultValue: "操作未完成" })}</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("translation.dictionary", { defaultValue: "离线词典" })}</CardTitle>
          <CardDescription>
            {t("translation.dictionaryHint", {
              defaultValue: "基础 77 万词条，支持词形与短语。查词不发起网络请求。",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            id="translation-local-search"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <FieldGroup>
              <Field data-disabled={searching}>
                <FieldLabel htmlFor="dictionary-word">
                  {t("translation.word", { defaultValue: "单词或短语" })}
                </FieldLabel>
                <Input
                  id="dictionary-word"
                  value={query}
                  maxLength={512}
                  disabled={searching}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="hello · went · take off"
                />
              </Field>
            </FieldGroup>
          </form>
          {entry && (
            <article className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-medium">{entry.entry.word}</h3>
                {entry.entry.phonetic && (
                  <span className="text-sm text-muted-foreground">/{entry.entry.phonetic}/</span>
                )}
                <Badge variant="secondary">
                  {t("translation.offline", { defaultValue: "离线" })}
                </Badge>
              </div>
              <p className="whitespace-pre-wrap text-sm">{entry.entry.translation}</p>
              {entry.entry.definition && (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {entry.entry.definition}
                </p>
              )}
              {entry.entry.exchange && (
                <p className="break-words text-xs text-muted-foreground">
                  {t("translation.inflections", { defaultValue: "词形变化" })}:
                  {entry.entry.exchange}
                </p>
              )}
              {entry.entry.tags && (
                <p className="text-xs text-muted-foreground">{entry.entry.tags}</p>
              )}
            </article>
          )}
          {!!items.length && (
            <div className="flex flex-col gap-1">
              {items.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  className="h-auto justify-start whitespace-normal py-2 text-left"
                  disabled={searching}
                  onClick={() => {
                    void detail(item.id);
                  }}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span>{item.title}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground">{item.description}</span>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          )}
          {!entry && !items.length && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {t("translation.localEmpty", { defaultValue: "输入单词开始查词" })}
                </EmptyTitle>
                <EmptyDescription>
                  {t("translation.localEmptyHint", {
                    defaultValue: "没有本地释义时，仍可主动选择下面的 AI 翻译。",
                  })}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button
            size="sm"
            form="translation-local-search"
            type="submit"
            disabled={searching || !query.trim()}
          >
            {searching && <Spinner data-icon="inline-start" />}
            {t("translation.lookup", { defaultValue: "本地查词" })}
          </Button>
          {entry && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || searching || exporting}
                onClick={() => void exportResult("copy", dictionaryText)}
              >
                {t("markdown.copy")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || searching || exporting || !notesAvailable}
                title={!notesAvailable ? unavailableTargetReason : undefined}
                onClick={() => void exportResult("notes", dictionaryText)}
              >
                {t("ocr.saveNote")}
              </Button>
            </>
          )}
        </CardFooter>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("translation.ai", { defaultValue: "AI 翻译" })}</CardTitle>
          <CardDescription>
            {t("translation.aiHint", {
              defaultValue: "仅点击翻译后联网。默认中文译为英文，其他语言译为简体中文。",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FieldGroup>
            <Field data-disabled={busy}>
              <FieldLabel htmlFor="translation-text">
                {t("translation.sourceText", { defaultValue: "原文" })}
              </FieldLabel>
              <Textarea
                id="translation-text"
                value={text}
                maxLength={20000}
                disabled={busy}
                onChange={(event) => {
                  resetTranslation();
                  setText(event.target.value);
                }}
                placeholder={t("translation.textPlaceholder", {
                  defaultValue: "粘贴要翻译的内容…",
                })}
              />
            </Field>
          </FieldGroup>
          {!config?.configured && (
            <Alert>
              <AlertDescription>
                {t("translation.needConfig", {
                  defaultValue: "先在下面保存兼容服务地址和模型；本地词典仍可使用。",
                })}
              </AlertDescription>
            </Alert>
          )}
          {(translated || busy || cancelled) && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {busy && <Spinner />}
                {translation?.cached && (
                  <Badge variant="secondary">
                    {t("translation.cached", { defaultValue: "缓存结果" })}
                  </Badge>
                )}
                {cancelled && (
                  <Badge variant="outline">
                    {t("translation.cancelled", { defaultValue: "已取消，保留当前文本" })}
                  </Badge>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm" aria-live="polite">
                {translated || t("translation.waiting", { defaultValue: "正在等待服务响应…" })}
              </p>
              {translation?.cacheSaved === false && (
                <p className="text-xs text-muted-foreground">
                  {t("translation.notCached", { defaultValue: "结果已返回，但本次未能保存缓存。" })}
                </p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || saving || !config?.configured || !text.trim()}
            onClick={() => {
              void translate();
            }}
          >
            {t("translation.translate", { defaultValue: "按默认方向翻译" })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || saving || !config?.configured || !text.trim()}
            onClick={() => {
              void translate(defaultEnglish ? "zh-CN" : "en");
            }}
          >
            {defaultEnglish
              ? t("translation.toChinese", { defaultValue: "改译为简体中文" })
              : t("translation.toEnglish", { defaultValue: "改译为英文" })}
          </Button>
          {busy && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void cancel();
              }}
            >
              {t("translation.cancel", { defaultValue: "取消请求" })}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || exporting || !translated}
            onClick={() => void exportResult("copy")}
          >
            {t("markdown.copy")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || exporting || !translated || !notesAvailable}
            title={!notesAvailable ? unavailableTargetReason : undefined}
            onClick={() => void exportResult("notes")}
          >
            {t("ocr.saveNote")}
          </Button>
        </CardFooter>
      </Card>

      <Button
        variant="outline"
        className="self-start"
        onClick={() => {
          void openSettingsWindow({
            page: "plugins",
            pluginId: "spark233.translation",
            tab: "config",
          }).catch((value) => setError(errorText(value)));
        }}
      >
        {t("pluginConfig.openSettings")}
      </Button>
    </section>
  );
}

export default TranslationWorkspace;
