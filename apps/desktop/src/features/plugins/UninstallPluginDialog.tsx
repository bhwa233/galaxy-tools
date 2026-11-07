import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import type { PluginSummary } from "./types";

/** Uninstall confirmation; plugin data is kept unless explicitly deleted. */
export function UninstallPluginDialog({
  plugin,
  busy,
  error,
  deleteData,
  onDeleteDataChange,
  onClose,
  onConfirm,
}: {
  plugin?: PluginSummary;
  busy: boolean;
  error?: string;
  deleteData: boolean;
  onDeleteDataChange: (value: boolean) => void;
  onClose: () => void;
  onConfirm: (plugin: PluginSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={!!plugin}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("plugins.uninstallTitle", { defaultValue: "卸载插件" })} · {plugin?.displayName}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("plugins.uninstallDescription", {
              defaultValue: "插件将停止运行并移除。默认保留插件数据，以便之后重新安装。",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={busy}>
            <Checkbox
              id="plugin-delete-data"
              checked={deleteData}
              onCheckedChange={(checked) => onDeleteDataChange(checked === true)}
              disabled={busy}
            />
            <FieldContent>
              <FieldLabel htmlFor="plugin-delete-data">
                {t("plugins.deleteData", { defaultValue: "同时删除此插件的数据" })}
              </FieldLabel>
              <FieldDescription>
                {t("plugins.deleteDataHint", {
                  defaultValue: "勾选后会永久删除插件私有数据，无法撤销。",
                })}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("plugins.keep", { defaultValue: "取消" })}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || !plugin}
            onClick={(event) => {
              event.preventDefault();
              if (plugin) onConfirm(plugin);
            }}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t("plugins.confirmUninstall", { defaultValue: "确认卸载" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
