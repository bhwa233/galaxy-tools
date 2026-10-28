import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownIcon, ArrowUpIcon, PinIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ManagementSurface";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type {
  LauncherLearningMutation,
  LauncherPreferenceEntry,
  LauncherPreferenceMutation,
  LauncherState,
} from "./types";

export interface LauncherPreferenceSelection {
  entry: LauncherPreferenceEntry;
  selectionId: string;
}

interface Props {
  embedded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: LauncherPreferenceEntry[];
  selection?: LauncherPreferenceSelection;
  ready: boolean;
  learning?: LauncherState["learning"];
  onLearningUpdate: (input: LauncherLearningMutation) => Promise<LauncherState>;
  onMutate: (input: LauncherPreferenceMutation) => Promise<LauncherState>;
}

export function LauncherPreferencesDialog({
  embedded = false,
  open,
  onOpenChange,
  entries,
  selection,
  ready,
  learning,
  onLearningUpdate,
  onMutate,
}: Props) {
  const { t, i18n } = useTranslation();
  const filterId = useId();
  const aliasesId = useId();
  const learningId = useId();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<"preference" | "learning" | "cleared">();
  const mutating = useRef(false);

  useEffect(() => {
    if (!open) return;
    setFilter(selection?.entry.title ?? "");
    setEditing(selection?.entry.key);
    setDraft(selection?.entry.aliases.join("\n") ?? "");
    setError(undefined);
    setSaved(undefined);
  }, [open, selection]);

  const catalog =
    selection && !entries.some((entry) => entry.key === selection.entry.key)
      ? [selection.entry, ...entries]
      : entries;
  const pinned = entries.filter((entry) => entry.pinned);
  const needle = filter.trim().toLocaleLowerCase();
  const visible = catalog.filter((entry) =>
    [entry.title, entry.description ?? "", entry.pluginId, entry.commandId ?? "", ...entry.aliases]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle),
  );

  const mutate = async (
    entry: LauncherPreferenceEntry,
    operation: LauncherPreferenceMutation["operation"],
    aliases?: string[],
  ) => {
    if (mutating.current || !ready) return;
    mutating.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const target = entries.some((current) => current.key === entry.key)
        ? { key: entry.key }
        : selection?.entry.key === entry.key
          ? { selectionId: selection.selectionId }
          : undefined;
      if (!target) throw new Error(t("launcher.preferences.expired"));
      await onMutate({ ...target, operation, ...(aliases ? { aliases } : {}) });
      if (operation === "aliases" || operation === "remove") setEditing(undefined);
      setSaved("preference");
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : value && typeof value === "object" && "message" in value
            ? String(value.message)
            : String(value),
      );
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };

  const mutateLearning = async (input: LauncherLearningMutation) => {
    if (mutating.current || !learning) return;
    mutating.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(undefined);
    try {
      await onLearningUpdate(input);
      setSaved(input.clear ? "cleared" : "learning");
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : value && typeof value === "object" && "message" in value
            ? String(value.message)
            : String(value),
      );
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog embedded={embedded} open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] min-h-0 flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("launcher.preferences.title")}</DialogTitle>
          <DialogDescription>{t("launcher.preferences.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
          <section
            className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3"
            aria-labelledby={`${learningId}-title`}
          >
            <h3 id={`${learningId}-title`} className="text-sm font-medium">
              {t("launcher.learning.title")}
            </h3>
            <Field orientation="horizontal" data-disabled={busy || !learning}>
              <Checkbox
                id={learningId}
                checked={learning?.enabled === true}
                disabled={busy || !learning}
                aria-describedby={`${learningId}-privacy`}
                onCheckedChange={(checked) => {
                  void mutateLearning({ enabled: checked === true });
                }}
              />
              <FieldContent>
                <FieldLabel htmlFor={learningId}>{t("launcher.learning.enable")}</FieldLabel>
                <FieldDescription id={`${learningId}-privacy`}>
                  {t("launcher.learning.privacy")}
                </FieldDescription>
              </FieldContent>
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t("launcher.learning.recordCount", {
                  count: learning?.recordCount ?? 0,
                  value: (learning?.recordCount ?? 0).toLocaleString(i18n.resolvedLanguage),
                })}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !learning || learning.recordCount === 0}
                onClick={() => {
                  void mutateLearning({ clear: true });
                }}
              >
                {t("launcher.learning.clear")}
              </Button>
            </div>
          </section>
          <p className="shrink-0 text-xs leading-relaxed text-muted-foreground">
            {t("launcher.preferences.hideScope")}
          </p>
          <div className="shrink-0 space-y-1.5">
            <label htmlFor={filterId} className="text-xs font-medium">
              {t("launcher.preferences.filterLabel")}
            </label>
            <Input
              id={filterId}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("launcher.preferences.filterPlaceholder")}
            />
          </div>
          {error && (
            <Alert variant="destructive" className="shrink-0">
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          )}
          <ul
            aria-label={t("launcher.preferences.listLabel")}
            aria-busy={busy || !ready}
            className="space-y-3"
          >
            {visible.map((entry) => {
              const pinIndex = pinned.findIndex((current) => current.key === entry.key);
              return (
                <li
                  key={entry.key}
                  data-preference-key={entry.key}
                  className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-words font-medium">{entry.title}</span>
                      <Badge variant="outline">{t(`launcher.preferences.${entry.kind}`)}</Badge>
                      {entry.pinned && (
                        <Badge variant="secondary">{t("launcher.preferences.pinned")}</Badge>
                      )}
                      {entry.hidden && (
                        <Badge variant="outline">{t("launcher.preferences.hidden")}</Badge>
                      )}
                      {!entry.available && (
                        <Badge variant="outline">{t("launcher.preferences.unavailable")}</Badge>
                      )}
                    </div>
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      {entry.pluginId}
                      {entry.commandId ? ` / ${entry.commandId}` : ""}
                    </p>
                    {entry.description && (
                      <p className="break-words text-xs text-muted-foreground">
                        {entry.description}
                      </p>
                    )}
                    {!!entry.aliases.length && (
                      <p className="break-words text-xs text-muted-foreground">
                        {t("launcher.preferences.aliasesSummary", {
                          aliases: entry.aliases.join(" · "),
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !ready || (!entry.available && !entry.pinned)}
                      onClick={() => void mutate(entry, entry.pinned ? "unpin" : "pin")}
                    >
                      <PinIcon aria-hidden="true" />
                      {t(entry.pinned ? "launcher.preferences.unpin" : "launcher.preferences.pin")}
                    </Button>
                    {entry.pinned && (
                      <>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          disabled={busy || !ready || pinIndex <= 0}
                          aria-label={t("launcher.preferences.moveUp", { title: entry.title })}
                          title={t("launcher.preferences.moveUp", { title: entry.title })}
                          onClick={() => void mutate(entry, "move-up")}
                        >
                          <ArrowUpIcon aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          disabled={
                            busy || !ready || pinIndex < 0 || pinIndex === pinned.length - 1
                          }
                          aria-label={t("launcher.preferences.moveDown", { title: entry.title })}
                          title={t("launcher.preferences.moveDown", { title: entry.title })}
                          onClick={() => void mutate(entry, "move-down")}
                        >
                          <ArrowDownIcon aria-hidden="true" />
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !ready}
                      onClick={() => {
                        setEditing(entry.key);
                        setDraft(entry.aliases.join("\n"));
                        setError(undefined);
                        setSaved(undefined);
                      }}
                    >
                      {t("launcher.preferences.editAliases")}
                    </Button>
                    {entry.kind === "command" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !ready}
                        onClick={() => void mutate(entry, entry.hidden ? "show" : "hide")}
                      >
                        {t(
                          entry.hidden ? "launcher.preferences.show" : "launcher.preferences.hide",
                        )}
                      </Button>
                    )}
                    {entry.kind === "application" && !entry.available && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !ready}
                        onClick={() => void mutate(entry, "remove")}
                      >
                        {t("launcher.preferences.removeMissing")}
                      </Button>
                    )}
                  </div>
                  {editing === entry.key && (
                    <div className="space-y-2 border-t border-border/70 pt-3">
                      <label htmlFor={aliasesId} className="text-xs font-medium">
                        {t("launcher.preferences.aliasesLabel")}
                      </label>
                      <Textarea
                        id={aliasesId}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        disabled={busy}
                        className="max-h-48 min-h-24 resize-y"
                        aria-describedby={`${aliasesId}-hint`}
                      />
                      <p
                        id={`${aliasesId}-hint`}
                        className="text-xs leading-relaxed text-muted-foreground"
                      >
                        {t("launcher.preferences.aliasesHint")}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={busy || !ready}
                          onClick={() =>
                            void mutate(
                              entry,
                              "aliases",
                              draft
                                .split(/\r?\n/)
                                .map((alias) => alias.trim())
                                .filter(Boolean),
                            )
                          }
                        >
                          {t("launcher.preferences.saveAliases")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing(undefined)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {!visible.length && (
              <li className="px-3 py-8 text-center text-sm text-muted-foreground">
                {t(ready ? "launcher.preferences.empty" : "launcher.preferences.loading")}
              </li>
            )}
          </ul>
        </div>
        <p
          role="status"
          className="flex min-h-5 shrink-0 items-center gap-2 text-xs text-muted-foreground"
        >
          {busy ? (
            <>
              <Spinner />
              {t("launcher.preferences.saving")}
            </>
          ) : saved ? (
            t(
              saved === "preference"
                ? "launcher.preferences.saved"
                : saved === "cleared"
                  ? "launcher.learning.cleared"
                  : "launcher.learning.saved",
            )
          ) : null}
        </p>
      </DialogContent>
    </Dialog>
  );
}
