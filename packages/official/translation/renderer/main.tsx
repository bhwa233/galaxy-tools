import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { TranslationWorkspace } from "../../../../apps/desktop/src/features/translation/TranslationWorkspace";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
const Page = () => (
  <PluginWindow>
    {({ payload, onClose, info }) => (
      <TranslationPage payload={payload} onClose={onClose} commands={info.commands} />
    )}
  </PluginWindow>
);
function TranslationPage({
  payload,
  onClose,
  commands,
}: {
  payload: unknown;
  onClose: () => Promise<void>;
  commands: string[];
}) {
  const { t } = useTranslation();
  const initial = useMemo(() => {
    const activation = (
      payload as
        | { activation?: { commandId?: string; context?: { kind: string; text?: string } } }
        | undefined
    )?.activation;
    if (!activation) return payload;
    const text = activation.context?.kind === "text" ? (activation.context.text ?? "") : "";
    return activation.commandId === "translate"
      ? {
          kind: "translate-input",
          text,
          ...(text.trim() ? { translateRequestId: crypto.randomUUID() } : {}),
        }
      : { kind: "dictionary-input", query: text };
  }, [payload]);
  return (
    <TranslationWorkspace
      initialResult={initial}
      onClose={onClose}
      notesAvailable={commands.includes("spark233.notes:new")}
      unavailableTargetReason={t("plugins.actionUnavailable")}
    />
  );
}
void mountDesktopApp(Page);
