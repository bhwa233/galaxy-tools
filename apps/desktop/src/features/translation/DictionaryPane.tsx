import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { DictionaryEntryResult, DictionaryItem } from "./types";

export interface DictionaryPaneProps {
  className?: string;
  query: string;
  entry?: DictionaryEntryResult;
  items: DictionaryItem[];
  searching: boolean;
  exporting: boolean;
  autoLookup: boolean;
  notesAvailable: boolean;
  unavailableTargetReason: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onDetail: (id: string) => void;
  onToggleAutoLookup: () => void;
  onCopyEntry: (content: string) => void;
  onSaveEntry: (content: string) => void;
}

export function DictionaryPane({
  className,
  query,
  entry,
  items,
  searching,
  exporting,
  autoLookup,
  notesAvailable,
  unavailableTargetReason,
  onQueryChange,
  onSearch,
  onDetail,
  onToggleAutoLookup,
  onCopyEntry,
  onSaveEntry,
}: DictionaryPaneProps) {
  const { t } = useTranslation();
  const text = entry
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
    <aside
      className={cn("flex min-h-0 flex-col gap-3 overflow-hidden p-3", className)}
      aria-label={t("translation.dictionary", { defaultValue: "离线词典" })}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {t("translation.dictionary", { defaultValue: "离线词典" })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-pressed={autoLookup}
          onClick={onToggleAutoLookup}
        >
          {autoLookup
            ? t("translation.autoLookupOn", { defaultValue: "选中即查：开" })
            : t("translation.autoLookupOff", { defaultValue: "选中即查：关" })}
        </Button>
      </div>
      <form
        id="translation-local-search"
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) onSearch();
        }}
      >
        <Input
          value={query}
          maxLength={512}
          disabled={searching}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("translation.word", { defaultValue: "单词或短语" })}
          aria-label={t("translation.word", { defaultValue: "单词或短语" })}
        />
        <Button size="sm" type="submit" disabled={searching || !query.trim()}>
          {searching && <Spinner data-icon="inline-start" />}
          {t("translation.lookup", { defaultValue: "查词" })}
        </Button>
      </form>
      <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
        {!!items.length && (
          <div className="flex max-h-48 shrink-0 flex-col overflow-y-auto border-b pb-2 sm:max-h-none sm:w-64 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
            {items.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className="h-auto justify-start py-1.5 text-left whitespace-normal"
                disabled={searching}
                onClick={() => onDetail(item.id)}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{item.title}</span>
                  {item.description && (
                    <span className="text-xs text-muted-foreground">{item.description}</span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {entry ? (
            <article className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-lg font-medium">{entry.entry.word}</h3>
                {entry.entry.phonetic && (
                  <span className="text-sm text-muted-foreground">/{entry.entry.phonetic}/</span>
                )}
                <Badge variant="secondary">
                  {t("translation.offline", { defaultValue: "离线" })}
                </Badge>
              </div>
              <p className="text-sm whitespace-pre-wrap">{entry.entry.translation}</p>
              {entry.entry.definition && (
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                  {entry.entry.definition}
                </p>
              )}
              {entry.entry.exchange && (
                <p className="text-xs break-words text-muted-foreground">
                  {t("translation.inflections", { defaultValue: "词形变化" })}：
                  {entry.entry.exchange}
                </p>
              )}
              {entry.entry.tags && (
                <p className="text-xs text-muted-foreground">{entry.entry.tags}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={exporting}
                  onClick={() => onCopyEntry(text)}
                >
                  {t("markdown.copy", { defaultValue: "复制" })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={exporting || !notesAvailable}
                  title={!notesAvailable ? unavailableTargetReason : undefined}
                  onClick={() => onSaveEntry(text)}
                >
                  {t("ocr.saveNote", { defaultValue: "保存便签" })}
                </Button>
              </div>
            </article>
          ) : !items.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {searching
                ? t("translation.searching", { defaultValue: "正在查词…" })
                : query.trim()
                  ? t("translation.noEntry", { defaultValue: "没有匹配的词条" })
                  : t("translation.localEmpty", { defaultValue: "输入单词开始查词" })}
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
