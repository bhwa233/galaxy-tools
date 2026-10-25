import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchServicePanel } from "./SearchServicePanel";
import { getSearchScope, pickSearchScopeDirectory, saveSearchScope } from "./api";

export interface SearchScopeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Compose the existing form/dialog primitives; paths are validated by the host. */
export function SearchScopeDialog({ open, onOpenChange }: SearchScopeDialogProps) {
  const { t } = useTranslation("search");
  const inputId = useId();
  const [paths, setPaths] = useState("");
  const [extensions, setExtensions] = useState("");
  const [maxFileMiB, setMaxFileMiB] = useState(64);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [busy, setBusy] = useState<"load" | "pick" | "save">();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const operating = useRef(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy("load");
    setLoaded(false);
    setError(undefined);
    void getSearchScope()
      .then((settings) => {
        if (!active) return;
        setPaths(settings.excludedRoots.join("\n"));
        setExtensions(settings.extensions.join(", "));
        setMaxFileMiB(settings.maxFileMiB);
        setIncludeHidden(settings.includeHidden);
        setLoaded(true);
      })
      .catch((value: unknown) => {
        if (active) setError(errorMessage(value));
      })
      .finally(() => {
        if (active) setBusy(undefined);
      });
    return () => {
      active = false;
    };
  }, [open]);
  async function run(action: "pick" | "save") {
    if (operating.current || busy || serviceBusy || !loaded) return;
    operating.current = true;
    setBusy(action);
    setError(undefined);
    try {
      if (action === "pick") {
        const directory = await pickSearchScopeDirectory();
        if (directory)
          setPaths((current) =>
            [
              ...new Set([...current.split(/\r?\n/).filter((value) => value.trim()), directory]),
            ].join("\n"),
          );
      } else {
        const settings = await saveSearchScope(
          paths
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
          {
            extensions: extensions
              .split(/[\s,;]+/)
              .map((extension) => extension.replace(/^\./, "").toLowerCase())
              .filter(Boolean),
            maxFileMiB,
            includeHidden,
          },
        );
        setPaths(settings.excludedRoots.join("\n"));
        onOpenChange(false);
      }
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      operating.current = false;
      setBusy(undefined);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!operating.current && !serviceBusy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl"
        showCloseButton={!operating.current && !serviceBusy}
        onEscapeKeyDown={(event) => {
          if (operating.current || serviceBusy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (operating.current || serviceBusy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-1">
          <p>{t("queryOnly")}</p>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t("error")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field data-disabled={!!busy || !loaded} data-invalid={!!error}>
              <FieldLabel htmlFor={inputId}>{t("excludedRoots")}</FieldLabel>
              <Textarea
                id={inputId}
                value={paths}
                rows={6}
                disabled={!!busy || !loaded}
                aria-invalid={!!error}
                aria-describedby={`${inputId}-help`}
                onChange={(event) => {
                  setPaths(event.target.value);
                  setError(undefined);
                }}
              />
              <FieldDescription id={`${inputId}-help`}>{t("pathHelp")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${inputId}-extensions`}>{t("extensions")}</FieldLabel>
              <Input
                id={`${inputId}-extensions`}
                value={extensions}
                disabled={!!busy || !loaded}
                onChange={(event) => setExtensions(event.target.value)}
              />
              <FieldDescription>{t("extensionsHelp")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${inputId}-size`}>{t("maxFileMiB")}</FieldLabel>
              <Input
                id={`${inputId}-size`}
                type="number"
                min={1}
                max={64}
                step={1}
                value={maxFileMiB}
                disabled={!!busy || !loaded}
                onChange={(event) => setMaxFileMiB(event.target.valueAsNumber)}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id={`${inputId}-hidden`}
                checked={includeHidden}
                disabled={!!busy || !loaded}
                onCheckedChange={(value) => setIncludeHidden(value === true)}
              />
              <FieldLabel htmlFor={`${inputId}-hidden`}>{t("includeHidden")}</FieldLabel>
            </Field>
          </FieldGroup>
          <Button
            variant="outline"
            disabled={!!busy || !loaded}
            onClick={() => {
              void run("pick");
            }}
          >
            {busy === "pick" && <Spinner data-icon="inline-start" />}
            {t("pick")}
          </Button>
          {busy && (
            <p role="status">
              {busy === "save" ? t("saving") : busy === "load" ? t("loading") : t("pick")}
            </p>
          )}
          <p>{t("applyHelp")}</p>
          <SearchServicePanel onBusyChange={setServiceBusy} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={operating.current || serviceBusy}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={!!busy || serviceBusy || !loaded}
            onClick={() => {
              void run("save");
            }}
          >
            {busy === "save" && <Spinner data-icon="inline-start" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(value: unknown): string {
  return value && typeof value === "object" && "message" in value
    ? String(value.message)
    : String(value);
}
