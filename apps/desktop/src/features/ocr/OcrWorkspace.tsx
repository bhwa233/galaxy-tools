import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { invoke, writeText } from "../../platform/desktop";

interface OcrData {
  sessionId: string;
  text: string;
  width: number;
  height: number;
  source: { id: string };
  lines: Array<{ text: string; box: number[][] }>;
}
interface OcrWorkspaceProps {
  initialResult: unknown;
  onClose: () => void;
  onResult: (value: unknown) => void;
  availableTargets: Record<"notes" | "dictionary" | "translate", boolean>;
  unavailableTargetReason: string;
}
type LineRange = { start: number; end: number };

export function OcrWorkspace({ initialResult, ...callbacks }: OcrWorkspaceProps) {
  const result = initialResult as OcrData;
  // The host reuses one OCR window; each completed session owns fresh editor,
  // selection and pending-action state even when the component stays mounted.
  return (
    <OcrResultWorkspace key={result.sessionId ?? result.source.id} result={result} {...callbacks} />
  );
}

function OcrResultWorkspace({
  result,
  onClose,
  onResult,
  availableTargets,
  unavailableTargetReason,
}: Omit<OcrWorkspaceProps, "initialResult"> & { result: OcrData }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [document, setDocument] = useState(() => {
    let cursor = 0;
    return {
      text: result.text ?? "",
      ranges: result.lines.map((line): LineRange | undefined => {
        const start = result.text.indexOf(line.text, cursor);
        if (start < 0) return;
        cursor = start + line.text.length;
        return { start, end: cursor };
      }),
    };
  });
  const { text, ranges } = document;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<number | undefined>(undefined);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const highlight = (start: number, end: number, currentRanges = ranges) => {
    setSelected(
      new Set(
        currentRanges.flatMap((range, index) =>
          range && start < range.end && end > range.start ? [index] : [],
        ),
      ),
    );
  };
  const selectLine = (index: number, extend = false) => {
    const range = ranges[index];
    if (!range) return;
    const first =
      extend && anchor.current !== undefined ? (ranges[anchor.current] ?? range) : range;
    if (!extend) anchor.current = index;
    const start = Math.min(first.start, range.start),
      end = Math.max(first.end, range.end);
    editor.current?.focus();
    editor.current?.setSelectionRange(start, end);
    highlight(start, end);
  };
  const changeText = (next: string, start: number, end: number) => {
    // Track each OCR row through the edited span. There is no editor primitive
    // for image anchors; untouched rows shift, replaced rows retain that span.
    let prefix = 0,
      suffix = 0;
    while (prefix < text.length && prefix < next.length && text[prefix] === next[prefix]) prefix++;
    while (
      suffix < text.length - prefix &&
      suffix < next.length - prefix &&
      text[text.length - suffix - 1] === next[next.length - suffix - 1]
    )
      suffix++;
    const previousEnd = text.length - suffix,
      nextEnd = next.length - suffix,
      delta = next.length - text.length;
    const updated = ranges.map(
      (range) =>
        range && {
          start:
            range.start <= prefix
              ? range.start
              : range.start >= previousEnd
                ? range.start + delta
                : prefix,
          end:
            range.end < prefix ? range.end : range.end >= previousEnd ? range.end + delta : nextEnd,
        },
    );
    setDocument({ text: next, ranges: updated });
    highlight(start, end, updated);
  };
  const chosen = () => {
    const node = editor.current;
    return node && node.selectionEnd > node.selectionStart
      ? text.slice(node.selectionStart, node.selectionEnd)
      : text;
  };
  const send = async (target: "notes" | "dictionary" | "translate") => {
    if (!availableTargets[target]) {
      setError(unavailableTargetReason);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const value = await invoke("text_action", { target, text: chosen() });
      if (active.current) onResult(value);
    } catch (value) {
      if (active.current)
        setError(
          value && typeof value === "object" && "message" in value
            ? String(value.message)
            : String(value),
        );
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4"
      aria-label={t("ocr.results", { defaultValue: "取字结果" })}
    >
      <div className="electron-title-drag flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => {
            editor.current?.focus();
            editor.current?.select();
            highlight(0, text.length);
          }}
        >
          {t("ocr.all", { defaultValue: "全部文字" })}
        </Button>
        <Button
          disabled={busy || !text}
          onClick={() => {
            void writeText(chosen()).catch((value) => setError(String(value)));
          }}
        >
          {t("ocr.copy", { defaultValue: "复制所选文字" })}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !text || !availableTargets.dictionary}
          title={!availableTargets.dictionary ? unavailableTargetReason : undefined}
          onClick={() => {
            void send("dictionary");
          }}
        >
          {t("ocr.lookup", { defaultValue: "查词" })}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !text || !availableTargets.translate}
          title={!availableTargets.translate ? unavailableTargetReason : undefined}
          onClick={() => {
            void send("translate");
          }}
        >
          {t("ocr.ai", { defaultValue: "AI 翻译" })}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !text || !availableTargets.notes}
          title={!availableTargets.notes ? unavailableTargetReason : undefined}
          onClick={() => {
            void send("notes");
          }}
        >
          {t("ocr.saveNote", { defaultValue: "保存便签" })}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          title={t("ocr.close")}
          aria-label={t("ocr.close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {Object.values(availableTargets).some((available) => !available) && (
        <p role="status" className="text-xs text-muted-foreground">
          {unavailableTargetReason}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
        {/* Native OCR boxes use image pixels; viewBox keeps selection aligned at
          any displayed size. No installed form primitive represents this overlay. */}
        <svg
          className="max-h-[55vh] w-full"
          viewBox={`0 0 ${result.width} ${result.height}`}
          role="group"
          aria-label={t("ocr.selection", { defaultValue: "原图与文字选区" })}
        >
          <image
            href={`spark233://resource/${encodeURIComponent(result.source.id)}`}
            width={result.width}
            height={result.height}
          />
          {result.lines.map((line, index) => (
            <polygon
              key={index}
              points={line.box.map((point) => point.join(",")).join(" ")}
              fill="currentColor"
              fillOpacity={selected.has(index) ? 0.25 : 0.04}
              stroke="currentColor"
              strokeWidth={selected.has(index) ? 2 : 1}
              role="button"
              tabIndex={0}
              aria-label={line.text}
              aria-pressed={selected.has(index)}
              onClick={(event) => selectLine(index, event.shiftKey)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectLine(index, event.shiftKey);
                }
              }}
            />
          ))}
        </svg>
        <Field>
          <FieldLabel htmlFor="ocr-text">
            {t("ocr.textLabel", { defaultValue: "识别文字，可编辑或框选部分文字" })}
          </FieldLabel>
          <Textarea
            id="ocr-text"
            ref={editor}
            value={text}
            onChange={(event) =>
              changeText(event.target.value, event.target.selectionStart, event.target.selectionEnd)
            }
            onSelect={(event) => {
              const node = event.currentTarget;
              highlight(node.selectionStart, node.selectionEnd);
            }}
            className="min-h-64 flex-1"
          />
        </Field>
      </div>
    </section>
  );
}
