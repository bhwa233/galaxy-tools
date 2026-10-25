import { useEffect, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  getCustomApplications,
  pickApplicationDirectory,
  pickCustomApplication,
  saveCustomApplications,
} from "./api";
import type { CustomApplicationEntry } from "./types";

export interface ApplicationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Compose existing shadcn form primitives; launch arguments stay an argv list. */
export function ApplicationsDialog({ open, onOpenChange }: ApplicationsDialogProps) {
  const { t } = useTranslation("applications");
  const [entries, setEntries] = useState<CustomApplicationEntry[]>([]);
  const [argumentsById, setArgumentsById] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState<"load" | "pick" | "save">();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const operating = useRef(false);
  const selected = entries.find((entry) => entry.id === selectedId);
  const executable = !!selected && /\.exe$/i.test(selected.path);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy("load");
    setLoaded(false);
    setError(undefined);
    void getCustomApplications()
      .then((settings) => {
        if (!active) return;
        setEntries(settings.entries);
        setArgumentsById(
          Object.fromEntries(
            settings.entries.map((entry) => [entry.id, JSON.stringify(entry.args, null, 2)]),
          ),
        );
        setSelectedId(settings.entries[0]?.id);
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

  function update(patch: Partial<CustomApplicationEntry>) {
    if (!selected) return;
    setEntries((current) =>
      current.map((entry) => (entry.id === selected.id ? { ...entry, ...patch } : entry)),
    );
    setError(undefined);
  }
  async function run(action: "add" | "path" | "cwd" | "save") {
    if (operating.current || busy || !loaded) return;
    operating.current = true;
    setBusy(action === "save" ? "save" : "pick");
    setError(undefined);
    try {
      if (action === "save") {
        const next = entries.map((entry) => {
          const args: unknown = JSON.parse(argumentsById[entry.id]?.trim() || "[]");
          if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))
            throw new Error(t("invalidArguments", { name: entry.title }));
          return { ...entry, args: args as string[] };
        });
        await saveCustomApplications(next);
        onOpenChange(false);
      } else if (action === "cwd") {
        const directory = await pickApplicationDirectory(t("pickDirectory"));
        if (directory) update({ cwd: directory });
      } else {
        const location = await pickCustomApplication(t("pickApplication"));
        if (!location) return;
        if (action === "add") {
          const id = crypto.randomUUID();
          setEntries((current) => [
            ...current,
            {
              id,
              title:
                location
                  .split(/[\\/]/)
                  .pop()
                  ?.replace(/\.(exe|lnk|url)$/i, "") || location,
              path: location,
              args: [],
              cwd: "",
            },
          ]);
          setArgumentsById((current) => ({ ...current, [id]: "[]" }));
          setSelectedId(id);
        } else {
          const isExe = /\.exe$/i.test(location);
          update({ path: location, ...(isExe ? {} : { args: [], cwd: "" }) });
          if (!isExe && selected)
            setArgumentsById((current) => ({ ...current, [selected.id]: "[]" }));
        }
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
        if (!operating.current) onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl"
        showCloseButton={!operating.current}
        onEscapeKeyDown={(event) => {
          if (operating.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (operating.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid min-h-0 gap-4 overflow-y-auto p-1 sm:grid-cols-[12rem_1fr]">
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              disabled={!!busy || !loaded || entries.length >= 200}
              onClick={() => {
                void run("add");
              }}
            >
              {t("add")}
            </Button>
            {!entries.length && loaded && <p className="text-muted-foreground">{t("empty")}</p>}
            {entries.map((entry) => (
              <Button
                key={entry.id}
                variant={entry.id === selectedId ? "secondary" : "ghost"}
                className="justify-start truncate"
                disabled={!!busy}
                onClick={() => setSelectedId(entry.id)}
              >
                {entry.title}
              </Button>
            ))}
          </div>
          {selected && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="application-title">{t("name")}</FieldLabel>
                <Input
                  id="application-title"
                  value={selected.title}
                  maxLength={160}
                  disabled={!!busy}
                  onChange={(event) => update({ title: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="application-path">{t("path")}</FieldLabel>
                <div className="flex gap-2">
                  <Input id="application-path" value={selected.path} readOnly />
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => {
                      void run("path");
                    }}
                  >
                    {t("choose")}
                  </Button>
                </div>
                <FieldDescription>{t("pathHelp")}</FieldDescription>
              </Field>
              {executable ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="application-args">{t("arguments")}</FieldLabel>
                    <Textarea
                      id="application-args"
                      rows={3}
                      value={argumentsById[selected.id] ?? "[]"}
                      disabled={!!busy}
                      onChange={(event) => {
                        setArgumentsById((current) => ({
                          ...current,
                          [selected.id]: event.target.value,
                        }));
                        setError(undefined);
                      }}
                    />
                    <FieldDescription>{t("argumentsHelp")}</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="application-cwd">{t("directory")}</FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        id="application-cwd"
                        value={selected.cwd}
                        disabled={!!busy}
                        onChange={(event) => update({ cwd: event.target.value })}
                      />
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => {
                          void run("cwd");
                        }}
                      >
                        {t("choose")}
                      </Button>
                    </div>
                    <FieldDescription>{t("directoryHelp")}</FieldDescription>
                  </Field>
                </>
              ) : (
                <p className="text-muted-foreground">{t("shortcutHelp")}</p>
              )}
              <Button
                variant="destructive"
                disabled={!!busy}
                onClick={() => {
                  const remaining = entries.filter((entry) => entry.id !== selected.id);
                  setEntries(remaining);
                  setSelectedId(remaining[0]?.id);
                }}
              >
                {t("remove")}
              </Button>
            </FieldGroup>
          )}
        </div>
        {busy && (
          <p role="status">
            {busy === "load" ? t("loading") : busy === "save" ? t("saving") : t("picking")}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={operating.current}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={!!busy || !loaded}
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
