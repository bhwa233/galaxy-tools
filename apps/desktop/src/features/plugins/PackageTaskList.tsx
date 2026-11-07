import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import type { PackageTaskSnapshot } from "./types";

const TERMINAL = ["completed", "cancelled", "failed", "recovery-required"];

/** Download/verify/install progress of package tasks, with per-task cancel. */
export function PackageTaskList({
  tasks,
  cancelling,
  onCancel,
}: {
  tasks: readonly PackageTaskSnapshot[];
  cancelling: readonly string[];
  onCancel: (taskId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <section className="flex flex-col gap-3" aria-label={t("plugins.tasks.title")}>
      <h3 className="text-sm font-medium">{t("plugins.tasks.title")}</h3>
      {tasks.map((task) => {
        const terminal = TERMINAL.includes(task.stage);
        const failed = task.stage === "failed" || task.stage === "recovery-required";
        const total =
          task.totalBytes !== undefined && Number.isFinite(task.totalBytes) && task.totalBytes > 0
            ? task.totalBytes
            : undefined;
        const received = Math.max(0, Number.isFinite(task.receivedBytes) ? task.receivedBytes : 0);
        const stopping = cancelling.includes(task.taskId) || task.stage === "cancelling";
        return (
          <Card key={task.taskId} size="sm" role="group" aria-label={task.packageName}>
            <CardHeader>
              <CardTitle className="break-all">{task.packageName}</CardTitle>
              <CardDescription className="flex flex-wrap gap-x-3 gap-y-1">
                {task.currentVersion && (
                  <span>{t("plugins.currentVersion", { version: task.currentVersion })}</span>
                )}
                {task.candidateVersion && (
                  <span>{t("plugins.candidateVersion", { version: task.candidateVersion })}</span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-2">
              <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
                {!terminal && task.stage !== "awaiting-confirmation" && <Spinner />}
                {t(`plugins.tasks.stage.${task.stage}`)}
              </p>
              {(task.stage === "downloading" || received > 0) && (
                <p className="text-xs text-muted-foreground">
                  {total
                    ? t("plugins.tasks.bytesKnown", {
                        received: received.toLocaleString(i18n.resolvedLanguage),
                        total: total.toLocaleString(i18n.resolvedLanguage),
                      })
                    : t("plugins.tasks.bytesUnknown", {
                        received: received.toLocaleString(i18n.resolvedLanguage),
                      })}
                </p>
              )}
              {task.stage === "downloading" && (
                <>
                  <progress
                    className="h-2 w-full accent-primary"
                    aria-label={t("plugins.tasks.downloadProgress", { name: task.packageName })}
                    {...(total ? { value: Math.min(received, total), max: total } : {})}
                  />
                  <p className="text-xs text-muted-foreground">{t("plugins.tasks.downloadHint")}</p>
                </>
              )}
              {failed && (
                <Alert variant="destructive">
                  <AlertDescription className="break-words">
                    {task.error || t("plugins.tasks.failedHint")}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
            {task.cancelable && (
              <CardFooter>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={stopping}
                  aria-label={t("plugins.tasks.cancelNamed", { name: task.packageName })}
                  onClick={() => onCancel(task.taskId)}
                >
                  {stopping ? t("plugins.tasks.stage.cancelling") : t("plugins.tasks.cancel")}
                </Button>
              </CardFooter>
            )}
          </Card>
        );
      })}
    </section>
  );
}
