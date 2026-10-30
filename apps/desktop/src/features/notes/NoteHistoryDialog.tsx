import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/desktop";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Note, NoteHistory, SaveNoteRequest } from "./types";

export function NoteHistoryDialog({
  noteId,
  onClose,
  beforeRestore,
  onRestored,
}: {
  noteId: string;
  onClose: () => void;
  beforeRestore: () => Promise<boolean>;
  onRestored: (note: Note) => void;
}) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<NoteHistory>();
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<SaveNoteRequest>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const report = (value: unknown) =>
    setError(
      value && typeof value === "object" && "message" in value
        ? String(value.message)
        : String(value),
    );
  const refresh = async () => setHistory(await invoke("notes_history", { id: noteId }));
  useEffect(() => {
    let active = true;
    void invoke("notes_history", { id: noteId })
      .then((value) => {
        if (active) setHistory(value);
      })
      .catch((value) => {
        if (active) report(value);
      });
    return () => {
      active = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate pending selection requests on unmount.
      generation.current++;
    };
  }, [noteId]);
  const select = async (versionId: string) => {
    const mine = ++generation.current;
    setSelected(versionId);
    setPreview(undefined);
    setError(undefined);
    try {
      const value = await invoke("notes_revision", { id: noteId, versionId });
      if (mine === generation.current) setPreview(value);
    } catch (value) {
      if (mine === generation.current) report(value);
    }
  };
  const restore = async () => {
    if (!selected || !history || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (!(await beforeRestore())) return;
      const note = await invoke("notes_history_restore", {
        id: noteId,
        versionId: selected,
        expectedRevision: history.currentRevision,
      });
      onRestored(note);
      onClose();
    } catch (value) {
      report(value);
      await refresh().catch(report);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("noteHistory.title")}</DialogTitle>
          <DialogDescription>{t("noteHistory.description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid min-h-0 flex-1 gap-3 overflow-auto sm:grid-cols-[200px_1fr]">
          <ul className="flex max-h-96 flex-col gap-1 overflow-auto">
            {history?.entries.map((entry) => (
              <li key={entry.versionId}>
                <Button
                  variant={selected === entry.versionId ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start"
                  disabled={busy}
                  onClick={() => void select(entry.versionId)}
                >
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="max-w-full truncate">{entry.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.savedAt).toLocaleString()}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          <Textarea
            readOnly
            aria-label={t("noteHistory.preview")}
            value={preview?.content ?? ""}
            className="min-h-64"
          />
        </div>
        {history?.entries.length === 0 && (
          <p className="text-muted-foreground">{t("noteHistory.empty")}</p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !preview} onClick={() => void restore()}>
            {t("noteHistory.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
