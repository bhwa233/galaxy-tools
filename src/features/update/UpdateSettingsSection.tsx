import { useTranslation } from "react-i18next";

// Registry plugin updates are owned by the plugin service; host upgrades use an installer.
export function UpdateSettingsSection(_props: { mode?: "settingsOnly" | "checkOnly" | "full" }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-paper-deep/40 p-4 text-sm text-ink-soft">
      <h3 className="font-medium mb-2">{t("settings.update.title")}</h3>
      <p>{t("settings.update.hostInstallHint")}</p>
      <p>{t("settings.update.registryPluginHint")}</p>
    </section>
  );
}
