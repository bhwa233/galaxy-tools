import { showToast } from "../../components/Toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ManagementSurface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { droppedApplicationEntries } from "../../platform/desktop";
import { useUnsavedChanges } from "../settings/useUnsavedChanges";
import {
  getCustomApplications,
  pickApplicationDirectory,
  pickCustomApplication,
  saveCustomApplications,
} from "./api";
import type {
  CustomApplicationEntry,
  CustomApplicationKind,
  CustomApplicationTarget,
} from "./types";

export interface ApplicationsDialogProps {
  embedded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Compose existing shadcn form primitives; launch arguments stay an argv list. */
export function ApplicationsDialog({
  open,
  onOpenChange,
  embedded = false,
}: ApplicationsDialogProps) {
  const { t } = useTranslation("applications");
  const { t: notificationText } = useTranslation();
  const [baseline, setBaseline] = useState<{
    entries: CustomApplicationEntry[];
    arguments: Record<string, string>;
  }>();
  const [entries, setEntries] = useState<CustomApplicationEntry[]>([]);
  const [argumentsById, setArgumentsById] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState<"load" | "pick" | "save">();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const operating = useRef(false);
  const [supportedKinds, setSupportedKinds] = useState<CustomApplicationKind[]>([
    "program",
    "shortcut",
  ]);
  const [revision, setRevision] = useState("");
  const selected = entries.find((entry) => entry.id === selectedId);
  const executable = selected?.kind === "program";
  const foldersSupported = supportedKinds.includes("directory");
  const canAddFile = supportedKinds.some((kind) => kind !== "directory");
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
        setRevision(settings.revision);
        setBaseline({
          entries: settings.entries,
          arguments: Object.fromEntries(
            settings.entries.map((entry) => [entry.id, JSON.stringify(entry.args, null, 2)]),
          ),
        });
        setSupportedKinds(settings.supportedKinds ?? ["program", "shortcut"]);
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
  function assertSupported(targets: CustomApplicationTarget[]) {
    const unsupported = targets.find((target) => !supportedKinds.includes(target.kind));
    if (unsupported)
      throw new Error(t("unsupportedKind", { kind: t(`kinds.${unsupported.kind}`) }));
  }
  function addTargets(targets: CustomApplicationTarget[]) {
    assertSupported(targets);
    if (!targets.length) throw new Error(t("dropUnavailable"));
    if (entries.length + targets.length > 200) throw new Error(t("tooMany"));
    const added = targets.map((target) => {
      const name =
        target.path
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() || target.path;
      return {
        id: crypto.randomUUID(),
        title: (target.kind === "program" || target.kind === "shortcut"
          ? name.replace(/\.(exe|lnk|url)$/i, "")
          : name
        ).slice(0, 160),
        path: target.path,
        kind: target.kind,
        args: [],
        cwd: "",
      };
    });
    setEntries((current) => [...current, ...added]);
    setArgumentsById((current) => ({
      ...current,
      ...Object.fromEntries(added.map((entry) => [entry.id, "[]"])),
    }));
    setSelectedId(added[0].id);
  }
  async function drop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (operating.current || busy || !loaded) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    if (files.length > 200 - entries.length) {
      setError(t("tooMany"));
      return;
    }
    operating.current = true;
    setBusy("pick");
    setError(undefined);
    try {
      addTargets(await droppedApplicationEntries(files));
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      operating.current = false;
      setBusy(undefined);
    }
  }
  async function run(
    action: "add-file" | "add-directory" | "path-file" | "path-directory" | "cwd" | "save",
    propagate = false,
  ) {
    if (operating.current || busy || !loaded) return;
    operating.current = true;
    setBusy(action === "save" ? "save" : "pick");
    setError(undefined);
    try {
      if (action === "save") {
        assertSupported(entries);
        const next = entries.map((entry) => {
          if (entry.kind !== "program") return { ...entry, args: [], cwd: "" };
          const args: unknown = JSON.parse(argumentsById[entry.id]?.trim() || "[]");
          if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))
            throw new Error(t("invalidArguments", { name: entry.title }));
          return { ...entry, args: args as string[] };
        });
        const saved = await saveCustomApplications(next, revision);
        setRevision(saved.revision);
        const args = Object.fromEntries(
          saved.entries.map((entry) => [entry.id, JSON.stringify(entry.args, null, 2)]),
        );
        setEntries(saved.entries);
        setArgumentsById(args);
        setBaseline({ entries: saved.entries, arguments: args });
        showToast(notificationText("notifications.saved"), "success");
        if (!embedded) onOpenChange(false);
      } else if (action === "cwd") {
        const directory = await pickApplicationDirectory();
        if (directory) update({ cwd: directory });
      } else {
        const target = await pickCustomApplication(action.endsWith("directory"));
        if (!target) return;
        assertSupported([target]);
        if (action.startsWith("add")) addTargets([target]);
        else {
          update({ ...target, ...(target.kind === "program" ? {} : { args: [], cwd: "" }) });
          if (target.kind !== "program" && selected)
            setArgumentsById((current) => ({ ...current, [selected.id]: "[]" }));
        }
      }
    } catch (value) {
      setError(errorMessage(value));
      if (propagate) throw value;
    } finally {
      operating.current = false;
      setBusy(undefined);
    }
  }

  const dirty =
    !!baseline &&
    (JSON.stringify(entries) !== JSON.stringify(baseline.entries) ||
      JSON.stringify(argumentsById) !== JSON.stringify(baseline.arguments));
  const discard = () => {
    if (baseline) {
      setEntries(baseline.entries);
      setArgumentsById(baseline.arguments);
    }
  };
  const guard = useUnsavedChanges(dirty, () => run("save", true), discard, open);
  return (
    <>
      <>{guard.dialog}</>
      <Dialog
        embedded={embedded}
        open={open}
        onOpenChange={(next) => {
          if (!operating.current) onOpenChange(next);
        }}
      >
        <DialogContent
          className="flex max-h-[85vh] min-h-0 flex-col overflow-hidden sm:max-w-3xl"
          data-application-entry-drop
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = loaded && !busy ? "copy" : "none";
            }
          }}
          onDrop={(event) => {
            void drop(event);
          }}
          showCloseButton={!operating.current}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-1">
            <DialogDescription>{t("description")}</DialogDescription>
            {error && (
              <Alert variant="destructive">
                <AlertTitle>{t("error")}</AlertTitle>
                <AlertDescription className="break-words">{error}</AlertDescription>
              </Alert>
            )}
            <section
              aria-label={t("dropTitle")}
              className="space-y-2 rounded-lg border border-dashed border-border bg-muted/25 p-3"
            >
              <p className="text-sm font-medium">{t("dropTitle")}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("dropHelp")}</p>
              <p className="text-xs text-muted-foreground">
                {t("supportedKinds", {
                  kinds: supportedKinds.map((kind) => t(`kinds.${kind}`)).join(" · "),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!!busy || !loaded || !canAddFile || entries.length >= 200}
                  onClick={() => void run("add-file")}
                >
                  {t("addFile")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!!busy || !loaded || !foldersSupported || entries.length >= 200}
                  onClick={() => void run("add-directory")}
                >
                  {t("addDirectory")}
                </Button>
              </div>
            </section>
            <div className="grid min-w-0 gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-2">
                {!entries.length && loaded && <p className="text-muted-foreground">{t("empty")}</p>}
                {entries.map((entry) => (
                  <Button
                    key={entry.id}
                    variant={entry.id === selectedId ? "secondary" : "ghost"}
                    className="h-auto min-h-8 min-w-0 justify-between gap-2 text-left"
                    disabled={!!busy}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span className="min-w-0 truncate">{entry.title}</span>
                    <Badge variant="outline" className="shrink-0">
                      {t(`kinds.${entry.kind}`)}
                    </Badge>
                  </Button>
                ))}
              </div>
              {selected && (
                <FieldGroup className="min-w-0">
                  <Field>
                    <FieldLabel>{t("kind")}</FieldLabel>
                    <p className="text-sm">{t(`kinds.${selected.kind}`)}</p>
                  </Field>
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
                    <div className="space-y-2">
                      <Input id="application-path" value={selected.path} readOnly />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={!!busy || !canAddFile}
                          onClick={() => {
                            void run("path-file");
                          }}
                        >
                          {t("chooseFile")}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={!!busy || !foldersSupported}
                          onClick={() => void run("path-directory")}
                        >
                          {t("chooseDirectory")}
                        </Button>
                      </div>
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
                        <div className="space-y-2">
                          <Input id="application-cwd" value={selected.cwd} readOnly />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              disabled={!!busy}
                              onClick={() => {
                                void run("cwd");
                              }}
                            >
                              {t("choose")}
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={!!busy || !selected.cwd}
                              onClick={() => update({ cwd: "" })}
                            >
                              {t("clearDirectory")}
                            </Button>
                          </div>
                        </div>
                        <FieldDescription>{t("directoryHelp")}</FieldDescription>
                      </Field>
                    </>
                  ) : (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {t(
                        selected.kind === "shortcut"
                          ? "shortcutHelp"
                          : selected.kind === "directory"
                            ? "folderHelp"
                            : "documentHelp",
                      )}
                    </p>
                  )}
                  <Button
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => {
                      const remaining = entries.filter((entry) => entry.id !== selected.id);
                      setEntries(remaining);
                      setSelectedId(remaining[0]?.id);
                      setArgumentsById((current) => {
                        const next = { ...current };
                        delete next[selected.id];
                        return next;
                      });
                      setError(undefined);
                    }}
                  >
                    {t("remove")}
                  </Button>
                </FieldGroup>
              )}
            </div>
          </div>
          {busy && (
            <p role="status">
              {busy === "load" ? t("loading") : busy === "save" ? t("saving") : t("picking")}
            </p>
          )}
          <DialogFooter className="shrink-0 flex-row flex-wrap justify-end">
            <Button
              variant="outline"
              disabled={operating.current}
              onClick={() => {
                if (embedded) discard();
                else onOpenChange(false);
              }}
            >
              {embedded ? t("discard", { defaultValue: "放弃更改" }) : t("cancel")}
            </Button>
            <Button
              disabled={!!busy || !loaded}
              onClick={() => {
                void guard.save().catch(() => {});
              }}
            >
              {busy === "save" && <Spinner data-icon="inline-start" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function errorMessage(value: unknown): string {
  return value && typeof value === "object" && "message" in value
    ? String(value.message)
    : String(value);
}
