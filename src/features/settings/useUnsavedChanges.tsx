import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerHostPreparation } from "../windows/hostPreparation";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** One pending leave decision per editor; host close and UI navigation share it. */
export function useUnsavedChanges(
  dirty: boolean,
  save: () => Promise<void>,
  discard: () => void,
  enabled = true,
) {
  const { t } = useTranslation();
  const current = useRef({ dirty, save, discard });
  current.current = { dirty, save, discard };
  const decision = useRef<
    { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined
  >(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pendingSave = useRef<Promise<void> | undefined>(undefined);
  const performSave = () => {
    if (pendingSave.current) return pendingSave.current;
    const operation = current.current.save();
    pendingSave.current = operation;
    void operation
      .finally(() => {
        pendingSave.current = undefined;
      })
      .catch(() => {});
    return operation;
  };
  useEffect(() => {
    if (!enabled) return;
    const stop = registerHostPreparation(async () => {
      await pendingSave.current;
      if (!current.current.dirty) return;
      if (!decision.current) {
        let resolve!: () => void, reject!: (error: Error) => void;
        const promise = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        decision.current = { promise, resolve, reject };
        setOpen(true);
      }
      await decision.current.promise;
    });
    return () => {
      stop();
      decision.current?.reject(new Error("Editor closed before a save decision"));
      decision.current = undefined;
    };
  }, [enabled]);
  const finish = (cancel = false) => {
    const waiting = decision.current;
    decision.current = undefined;
    setOpen(false);
    setError(undefined);
    if (cancel) waiting?.reject(new Error(t("settingsEditor.navigationCancelled")));
    else waiting?.resolve();
  };
  return {
    save: performSave,
    dialog: (
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!value && !busy) finish(true);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settingsEditor.unsaved")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settingsEditor.unsavedDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => finish(true)}>
              {t("settingsEditor.cancel")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                current.current.discard();
                finish();
              }}
            >
              {t("settingsEditor.discard")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void performSave()
                  .then(() => finish())
                  .catch((value) => setError(value?.message ?? String(value)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("settingsEditor.save")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
