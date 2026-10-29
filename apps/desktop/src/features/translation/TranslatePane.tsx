import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TranslationResult } from "./types";

export interface TranslatePaneProps {
  className?: string;
  text: string;
  translated: string;
  translation?: TranslationResult;
  busy: boolean;
  cancelled: boolean;
  exporting: boolean;
  configured: boolean;
  /** Automatic direction returned by the plugin's language rule. */
  target: "en" | "zh-CN";
  /** Direction the user forced through the flip control. */
  override?: "en" | "zh-CN";
  notesAvailable: boolean;
  unavailableTargetReason: string;
  onTextChange: (value: string) => void;
  onTranslate: (target?: "en" | "zh-CN") => void;
  onCancel: () => void;
  onFlip: () => void;
  onClearOverride: () => void;
  onClear: () => void;
  onCopy: () => void;
  onSaveNote: () => void;
  onConfigure: () => void;
  onLookupSelection: (value: string) => void;
  onClose: () => void;
}

export function TranslatePane({
  className,
  text,
  translated,
  translation,
  busy,
  cancelled,
  exporting,
  configured,
  target,
  override,
  notesAvailable,
  unavailableTargetReason,
  onTextChange,
  onTranslate,
  onCancel,
  onFlip,
  onClearOverride,
  onClear,
  onCopy,
  onSaveNote,
  onConfigure,
  onLookupSelection,
  onClose,
}: TranslatePaneProps) {
  const { t } = useTranslation();
  const direction = target === "en" ? "translation.directionZhEn" : "translation.directionEnZh";
  const blocked = busy || !configured || !text.trim();
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex min-h-0 flex-[3] flex-col gap-1.5">
        <div className="electron-title-drag flex shrink-0 items-center justify-between gap-2">
          <label htmlFor="translation-text" className="text-xs text-muted-foreground">
            {t("translation.sourceText", { defaultValue: "原文" })}
          </label>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("translation.close")}
            aria-label={t("translation.close")}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <Textarea
          id="translation-text"
          value={text}
          maxLength={20000}
          disabled={busy}
          className="min-h-0 flex-1 resize-none"
          placeholder={t("translation.textPlaceholder", { defaultValue: "粘贴要翻译的内容…" })}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (!blocked) onTranslate();
            }
          }}
          onMouseUp={(event) => {
            const node = event.currentTarget;
            if (node.selectionEnd > node.selectionStart)
              onLookupSelection(text.slice(node.selectionStart, node.selectionEnd));
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
          {override
            ? t(direction, { defaultValue: "中 → 英" })
            : `${t("translation.directionAuto", { defaultValue: "自动" })} · ${t(direction, {
                defaultValue: "中 → 英",
              })}`}
        </span>
        <Button size="sm" variant="ghost" onClick={onFlip} disabled={busy}>
          {t("translation.flip", { defaultValue: "翻转方向" })}
        </Button>
        {override && (
          <Button size="sm" variant="ghost" onClick={onClearOverride} disabled={busy}>
            {t("translation.resetDirection", { defaultValue: "恢复自动" })}
          </Button>
        )}
        {busy ? (
          <Button size="sm" variant="outline" onClick={onCancel}>
            {t("translation.stop", { defaultValue: "停止" })}
          </Button>
        ) : (
          <Button size="sm" disabled={blocked} onClick={() => onTranslate()}>
            {t("translation.translate", { defaultValue: "翻译" })}
            <kbd className="ml-1 text-[0.7rem] opacity-70">Ctrl+↵</kbd>
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-[4] flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("translation.targetText", { defaultValue: "译文" })}
          </span>
          {busy && <Spinner />}
          {translation?.cached && (
            <span className="text-xs text-muted-foreground">
              {t("translation.cached", { defaultValue: "缓存结果" })}
            </span>
          )}
          {cancelled && (
            <span className="text-xs text-muted-foreground">
              {t("translation.cancelled", { defaultValue: "已取消，保留当前文本" })}
            </span>
          )}
          {translation?.cacheSaved === false && (
            <span className="text-xs text-muted-foreground">
              {t("translation.notCached", { defaultValue: "结果已返回，但本次未能保存缓存。" })}
            </span>
          )}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-sm break-words whitespace-pre-wrap select-text"
          aria-live="polite"
          onMouseUp={() => {
            const selection = window.getSelection()?.toString().trim();
            if (selection) onLookupSelection(selection);
          }}
        >
          {translated || (
            <span className="text-muted-foreground">
              {busy
                ? t("translation.waiting", { defaultValue: "正在等待服务响应…" })
                : configured
                  ? t("translation.targetEmpty", { defaultValue: "译文会出现在这里。" })
                  : t("translation.configMissing", {
                      defaultValue: "尚未配置翻译服务，配好后即可翻译。",
                    })}
            </span>
          )}
        </div>
        {!configured && (
          <Button size="sm" variant="outline" className="self-start" onClick={onConfigure}>
            {t("translation.configAction", { defaultValue: "配置翻译服务" })}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={exporting || !translated} onClick={onCopy}>
          {t("markdown.copy", { defaultValue: "复制" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={exporting || !translated || !notesAvailable}
          title={!notesAvailable ? unavailableTargetReason : undefined}
          onClick={onSaveNote}
        >
          {t("ocr.saveNote", { defaultValue: "保存便签" })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || (!text && !translated)}
          onClick={onClear}
        >
          {t("translation.clear", { defaultValue: "清空" })}
        </Button>
      </div>
    </div>
  );
}
