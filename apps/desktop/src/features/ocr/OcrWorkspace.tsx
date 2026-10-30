import { showToast } from "../../components/Toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { invoke, writeText } from "../../platform/desktop";
import { WorkspaceTitleBar } from "../windows/WorkspaceTitleBar";

import type { OcrSession, OcrSessionSummary, OcrDocument } from "../../../shared/ocr-sessions";
import { registerHostPreparation } from "../windows/hostPreparation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { OcrImage } from "./OcrImage";
interface OcrWorkspaceProps {
  initialResult: unknown;
  onClose: () => void;
  onResult: (value: unknown) => void;
  availableTargets: Record<"notes" | "dictionary" | "translate", boolean>;
  unavailableTargetReason?: string;
}
type LineRange = { start: number; end: number };

export function OcrWorkspace({ initialResult, ...callbacks }: OcrWorkspaceProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<OcrSession | undefined>(undefined);
  const [sessions, setSessions] = useState<OcrSessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string>();
  const [error, setError] = useState<string>();
  const pending = useRef(new Map<string, OcrDocument>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const refresh = async () =>
    setSessions((await invoke("ocr_action", { action: "list" })) as OcrSessionSummary[]);
  const flush = () => {
    clearTimeout(timer.current);
    const operation = queue.current
      .catch(() => {})
      .then(async () => {
        // Edits can arrive while IPC is saving. Preparation is ready only once
        // the most recent draft of every session has reached durable storage.
        while (pending.current.size)
          for (const [sessionId, document] of pending.current) {
            await invoke("ocr_action", { action: "save", sessionId, document });
            if (pending.current.get(sessionId) === document) pending.current.delete(sessionId);
          }
        if (alive.current) setError(undefined);
      });
    queue.current = operation;
    return operation;
  };
  const report = (value: unknown) => {
    if (alive.current)
      setError(
        value && typeof value === "object" && "message" in value
          ? String(value.message)
          : String(value),
      );
  };
  useEffect(() => {
    alive.current = true;
    const unregister = registerHostPreparation(flush);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      unregister();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      await flush();
      const list = (await invoke("ocr_action", { action: "list" })) as OcrSessionSummary[];
      if (!active) return;
      setSessions(list);
      const id = (initialResult as OcrSession | undefined)?.sessionId ?? list[0]?.sessionId;
      if (id) {
        const next = (await invoke("ocr_action", { action: "get", sessionId: id })) as OcrSession;
        if (active) setResult(next);
      }
    })().catch(report);
    return () => {
      active = false;
    };
  }, [initialResult]);

  const change = (sessionId: string, document: OcrDocument) => {
    pending.current.set(sessionId, document);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush().catch(report), 250);
  };
  const openSession = async (sessionId: string) => {
    try {
      await flush();
      const next = (await invoke("ocr_action", { action: "get", sessionId })) as OcrSession;
      setResult(next);
      setHistoryOpen(false);
    } catch (value) {
      report(value);
    }
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <WorkspaceTitleBar title={t("ocr.results")} onClose={callbacks.onClose} onError={report} />
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setHistoryOpen(true);
            void refresh().catch(report);
          }}
        >
          {t("ocr.history")}
        </Button>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void flush().then(refresh).catch(report)}
            >
              {t("common.retry")}
            </Button>
          </Alert>
        )}
      </div>
      {result ? (
        <OcrResultWorkspace
          key={result.sessionId ?? result.source.id}
          result={result}
          onDocument={(document) => change(result.sessionId, document)}
          {...callbacks}
        />
      ) : (
        <p className="p-4 text-muted-foreground">{t("ocr.noSessions")}</p>
      )}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ocr.history")}</DialogTitle>
            <DialogDescription>{t("ocr.historyHelp")}</DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-96 flex-col gap-2 overflow-auto">
            {sessions.map((session) => (
              <li key={session.sessionId} className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => void openSession(session.sessionId)}
                >
                  <span className="truncate">
                    {session.title || t("ocr.results")}
                    {session.edited ? " · " + t("ocr.draft") : ""}
                  </span>
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRemoveId(session.sessionId)}>
                  {t("common.delete")}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!removeId}
        onOpenChange={(open) => {
          if (!open) setRemoveId(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ocr.removeSession")}</AlertDialogTitle>
            <AlertDialogDescription>{t("ocr.removeSessionHelp")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await flush();
                  await invoke("ocr_action", { action: "remove", sessionId: removeId! });
                  if (result?.sessionId === removeId) setResult(undefined);
                  setRemoveId(undefined);
                  await refresh();
                } catch (value) {
                  report(value);
                }
              }}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function OcrResultWorkspace({
  result,
  onResult,
  availableTargets,
  unavailableTargetReason: unavailableReason,
  onDocument,
}: Omit<OcrWorkspaceProps, "initialResult"> & {
  result: OcrSession;
  onDocument: (document: OcrDocument) => void;
}) {
  const { t } = useTranslation();
  const unavailableTargetReason = unavailableReason ?? t("plugins.actionUnavailable");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [document, setDocument] = useState(() => {
    if (result.draft)
      return {
        text: result.draft.text,
        ranges: result.draft.ranges.map((range) => range ?? undefined),
      };
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
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const highlight = (start: number, end: number) => {
    setSelection({ start, end });
  };
  const selectRange = (start: number, end: number) => {
    editor.current?.focus({ preventScroll: true });
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
    onDocument({ text: next, ranges: updated.map((range) => range ?? null) });
    highlight(start, end);
  };
  const chosen = () => {
    const node = editor.current;
    return node && node.selectionEnd > node.selectionStart
      ? text.slice(node.selectionStart, node.selectionEnd)
      : text;
  };
  const send = async (target: "notes" | "dictionary" | "translate") => {
    if (!availableTargets[target]) {
      showToast(unavailableTargetReason);
      return;
    }
    setBusy(true);
    try {
      const value = await invoke("text_action", { target, text: chosen() });
      if (active.current) {
        if (target === "notes") showToast(t("notifications.noteSaved"), "success");
        onResult(value);
      }
    } catch (value) {
      if (active.current)
        showToast(
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
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label={t("ocr.results", { defaultValue: "取字结果" })}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-wrap items-center gap-2">
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
              void writeText(chosen())
                .then(() => {
                  if (active.current) showToast(t("notifications.copied"), "success");
                })
                .catch((value) => {
                  if (active.current)
                    showToast(
                      value && typeof value === "object" && "message" in value
                        ? String(value.message)
                        : String(value),
                    );
                });
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
        </div>
        {Object.values(availableTargets).some((available) => !available) && (
          <p role="status" className="text-xs text-muted-foreground">
            {unavailableTargetReason}
          </p>
        )}
        <div className="grid shrink-0 gap-4 md:min-h-0 md:flex-1 md:grid-cols-2">
          <OcrImage
            result={result}
            document={{ text, ranges: ranges.map((range) => range ?? null) }}
            selection={selection}
            onSelect={selectRange}
          />
          <Field>
            <FieldLabel htmlFor="ocr-text">
              {t("ocr.textLabel", { defaultValue: "识别文字，可编辑或框选部分文字" })}
            </FieldLabel>
            <Textarea
              id="ocr-text"
              ref={editor}
              value={text}
              onChange={(event) =>
                changeText(
                  event.target.value,
                  event.target.selectionStart,
                  event.target.selectionEnd,
                )
              }
              onSelect={(event) => {
                const node = event.currentTarget;
                highlight(node.selectionStart, node.selectionEnd);
              }}
              className="min-h-64 flex-1"
            />
          </Field>
        </div>
      </div>
    </section>
  );
}
