import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { PluginSummary } from "./types";

// Reuse Badge and native Intl formatting; this only composes the plugin's
// release version and host-validated development identity for management UI.
export function PluginVersion({
  version,
  development,
  badge = false,
}: Pick<PluginSummary, "version" | "development"> & { badge?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {badge ? <Badge variant="outline">{version}</Badge> : <span>{version}</span>}
      {development && <Badge variant="secondary">{t("plugins.development.label")}</Badge>}
    </span>
  );
}

export function PluginBuildInfo({ development }: Pick<PluginSummary, "development">) {
  const { t, i18n } = useTranslation();
  if (!development) return null;
  const builtAt = development.builtAt ? new Date(development.builtAt) : undefined;
  return (
    <dl
      aria-label={t("plugins.development.details")}
      className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap gap-x-2">
        <dt>{t("plugins.development.buildId")}</dt>
        <dd className="break-all">{development.buildId}</dd>
      </div>
      {builtAt && Number.isFinite(builtAt.getTime()) && (
        <div className="flex flex-wrap gap-x-2">
          <dt>{t("plugins.development.builtAt")}</dt>
          <dd>
            <time dateTime={builtAt.toISOString()}>
              {builtAt.toLocaleString(i18n.resolvedLanguage, {
                timeZone: "UTC",
                timeZoneName: "short",
              })}
            </time>
          </dd>
        </div>
      )}
      {development.commit && (
        <div className="flex flex-wrap gap-x-2">
          <dt>{t("plugins.development.commit")}</dt>
          <dd title={development.commit}>{development.commit.slice(0, 12)}</dd>
        </div>
      )}
    </dl>
  );
}
