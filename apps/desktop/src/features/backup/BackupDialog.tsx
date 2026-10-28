import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ManagementSurface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createBackup, inspectBackup, releaseBackupSelection, restoreBackup } from "./api";
import type { BackupReport, BackupSelection } from "./types";

export interface BackupDialogProps {
  embedded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Reuse the existing Dialog/Card/Alert primitives and desktop boundary. State
// here represents only the user's selection and the host's verified preview.
export function BackupDialog({ open, onOpenChange, embedded = false }: BackupDialogProps) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState<"create" | "inspect" | "restore">();
  const [selection, setSelection] = useState<BackupSelection>();
  const selectionRef = useRef<BackupSelection | undefined>(undefined);
  const selectionGeneration = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const [report, setReport] = useState<BackupReport>();
  const [error, setError] = useState<string>();
  const operating = useRef(false);
  const mounted = useRef(true);
  const clearSelection = () => {
    selectionGeneration.current++;
    const previous = selectionRef.current;
    selectionRef.current = undefined;
    if (mounted.current) setSelection(undefined);
    if (previous) void releaseBackupSelection(previous.selectionId).catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearSelection();
    };
  }, []);
  useEffect(() => {
    if (!open) clearSelection();
  }, [open]);
  const run = async (action: "create" | "inspect" | "restore") => {
    if (operating.current || (action === "restore" && !selection)) return;
    operating.current = true;
    setBusy(action);
    setError(undefined);
    setReport(undefined);
    if (action === "inspect") clearSelection();
    const generation = selectionGeneration.current;
    try {
      if (action === "inspect") {
        const next = await inspectBackup();
        if (next) {
          if (mounted.current && openRef.current && selectionGeneration.current === generation) {
            selectionRef.current = next;
            setSelection(next);
          } else void releaseBackupSelection(next.selectionId).catch(() => {});
        }
      } else {
        const next =
          action === "create" ? await createBackup() : await restoreBackup(selection!.selectionId);
        if (mounted.current && next) {
          setReport(next);
          if (action === "restore") clearSelection();
        }
      }
    } catch (value) {
      if (mounted.current) {
        if (
          value &&
          typeof value === "object" &&
          "code" in value &&
          value.code === "backupSelectionChanged"
        ) {
          clearSelection();
          setError(t("backup.selectionChanged"));
        } else {
          setError(
            value && typeof value === "object" && "message" in value
              ? String(value.message)
              : String(value),
          );
        }
      }
    } finally {
      operating.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const size = (bytes: number) =>
    `${(bytes / (1024 * 1024)).toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 2 })} MiB`;
  return (
    <Dialog
      embedded={embedded}
      open={open}
      onOpenChange={(next) => {
        if (!operating.current) {
          if (!next) clearSelection();
          onOpenChange(next);
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (operating.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (operating.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("backup.title", { defaultValue: "备份与恢复" })}</DialogTitle>
          <DialogDescription>
            {t("backup.description", {
              defaultValue:
                "一起保存设置、便签正文与附件、插件版本和启停状态，以及剪贴板等插件数据。恢复前会验证全部文件并保留当前数据副本。",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-1 *:shrink-0">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!!busy}
              onClick={() => {
                void run("create");
              }}
            >
              {busy === "create" && <Spinner data-icon="inline-start" />}
              {t("backup.create", { defaultValue: "创建备份" })}
            </Button>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => {
                void run("inspect");
              }}
            >
              {busy === "inspect" && <Spinner data-icon="inline-start" />}
              {t("backup.inspect", { defaultValue: "选择备份并验证" })}
            </Button>
          </div>
          {busy && (
            <p role="status">
              {busy === "inspect"
                ? t("backup.inspecting", { defaultValue: "正在核对备份清单和文件……" })
                : busy === "restore"
                  ? t("backup.restoring", { defaultValue: "正在恢复，请等待完成……" })
                  : t("backup.creating", { defaultValue: "正在保存并创建一致快照……" })}
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t("backup.error", { defaultValue: "操作未完成" })}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {selection && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {t("backup.confirmTitle", { defaultValue: "确认恢复此备份" })}
                </CardTitle>
                <CardDescription>
                  {new Date(selection.createdAt).toLocaleString(i18n.resolvedLanguage)} · spark233{" "}
                  {selection.hostVersion} ·{" "}
                  {t("backup.fileCount", {
                    count: selection.files,
                    defaultValue: "{{count}} 个文件",
                  })}{" "}
                  · {size(selection.bytes)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="break-all">{selection.snapshotDirectory}</p>
                <ul
                  className="flex flex-col gap-2"
                  aria-label={t("backup.plugins", { defaultValue: "将恢复的插件" })}
                >
                  {selection.plugins.map((plugin) => (
                    <li key={plugin.pluginId} className="flex flex-wrap items-center gap-2">
                      <span>
                        {plugin.pluginId} · {plugin.version}
                      </span>
                      <Badge variant={plugin.enabled ? "secondary" : "outline"}>
                        {plugin.enabled
                          ? t("backup.enabled", { defaultValue: "启用" })
                          : t("backup.disabled", { defaultValue: "停用" })}
                      </Badge>
                      {plugin.grant?.native && (
                        <Badge variant="outline">{t("backup.nativeTrust")}</Badge>
                      )}
                      {!!plugin.grant?.capabilities.length && (
                        <span className="text-xs text-muted-foreground">
                          {t("backup.permissions")}: {plugin.grant.capabilities.join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <Alert>
                  <AlertDescription>
                    {t("backup.confirmDescription", {
                      defaultValue:
                        "确认后将恢复以上插件版本、已授予的能力和数据。当前数据会另行保留，未保存的便签会先请求保存；保存未完成时会取消恢复。",
                    })}
                  </AlertDescription>
                </Alert>
              </CardContent>
              <CardFooter className="gap-2">
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    void run("restore");
                  }}
                >
                  {busy === "restore" && <Spinner data-icon="inline-start" />}
                  {t("backup.confirm", { defaultValue: "确认恢复" })}
                </Button>
                <Button variant="outline" disabled={!!busy} onClick={clearSelection}>
                  {t("backup.cancelSelection", { defaultValue: "取消选择" })}
                </Button>
              </CardFooter>
            </Card>
          )}
          {report && (
            <Alert>
              <AlertTitle>{t("backup.success", { defaultValue: "操作完成" })}</AlertTitle>
              <AlertDescription>
                <p>
                  {t("backup.fileCount", { count: report.files, defaultValue: "{{count}} 个文件" })}{" "}
                  · {size(report.bytes)}
                </p>
                <p className="break-all">
                  {t("backup.snapshotPath", {
                    path: report.snapshotDirectory,
                    defaultValue: "备份：{{path}}",
                  })}
                </p>
                {report.recoveryDirectory && (
                  <p className="break-all">
                    {t("backup.recoveryPath", {
                      path: report.recoveryDirectory,
                      defaultValue: "当前数据保护副本：{{path}}",
                    })}
                  </p>
                )}
                {report.warnings.length > 0 && (
                  <ul>
                    {report.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
