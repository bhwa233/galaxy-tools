import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Package, RefreshCw } from "lucide-react";
import type { PluginMarketSort, UToolsCatalogPage } from "../../../shared/plugin-market";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Spinner } from "../../components/ui/spinner";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { openUrl } from "../../platform/desktop";
import { queryUToolsCatalog } from "./api";

export function UToolsCatalogList({
  query,
  sort,
  active,
  onPrepare,
}: {
  query: string;
  sort: PluginMarketSort;
  active: boolean;
  onPrepare(catalogId: string): void;
}) {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<UToolsCatalogPage>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const lastRefresh = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const force = revision !== lastRefresh.current;
    lastRefresh.current = revision;
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError(undefined);
        void queryUToolsCatalog({ query, sort, page, ...(force ? { refresh: true } : {}) })
          .then((value) => {
            if (!current) return;
            setResult(value);
            // The host clamps pages after an upstream directory change.
            if (value.page !== page) setPage(value.page);
            list.current?.scrollIntoView({ block: "nearest" });
          })
          .catch((value) => {
            if (current) setError(value instanceof Error ? value.message : String(value));
          })
          .finally(() => {
            if (current) setLoading(false);
          });
      },
      query.trim() && !force ? 160 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, sort, page, revision, active]);
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 20)));
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>{t("pluginMarket.utools.title")}</CardTitle>
            <CardDescription>{t("pluginMarket.utools.description")}</CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw aria-hidden data-icon="inline-start" />
            {t("pluginMarket.utools.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {t("pluginMarket.utools.failed")} {error}
            </AlertDescription>
          </Alert>
        )}
        {loading && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t("pluginMarket.utools.loading")}
          </p>
        )}
        {result?.stale && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("pluginMarket.utools.cached", {
              time: new Date(result.fetchedAt).toLocaleString(i18n.resolvedLanguage),
            })}
          </p>
        )}
        <div
          ref={list}
          role="list"
          aria-label={t("pluginMarket.utools.title")}
          aria-busy={loading}
          className="flex flex-col gap-3"
        >
          {result?.items.map((item) => (
            <div
              key={item.pluginId}
              role="listitem"
              aria-label={item.displayName}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="relative flex size-8 shrink-0 items-center justify-center text-muted-foreground">
                  <Package aria-hidden className="size-6" />
                  {item.iconURL && (
                    <img
                      src={item.iconURL}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="absolute inset-0 size-8 rounded object-contain"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-sm font-medium">{item.displayName}</span>
                    <Badge variant="outline">uTools</Badge>
                    {item.installedPluginId && (
                      <Badge variant="secondary">{t("pluginMarket.utools.installed")}</Badge>
                    )}
                  </div>
                  {item.author && (
                    <p className="break-words text-xs text-muted-foreground">{item.author}</p>
                  )}
                  {item.description && (
                    <p className="line-clamp-2 break-words text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {item.rating && item.rating > 0
                      ? t("pluginMarket.utools.rating", { rating: item.rating.toFixed(1) })
                      : t("pluginMarket.utools.unrated")}
                    {item.voters !== undefined &&
                      ` · ${t("pluginMarket.utools.voters", { count: item.voters })}`}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => onPrepare(item.pluginId)}>
                  <Download aria-hidden data-icon="inline-start" />
                  {t("pluginMarket.utools.prepare")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void openUrl(item.pageURL).catch((value) => setError(String(value)));
                  }}
                >
                  <ExternalLink aria-hidden data-icon="inline-start" />
                  {t("pluginMarket.utools.officialPage")}
                </Button>
              </div>
            </div>
          ))}
        </div>
        {result && !result.total && (
          <Empty role="status">
            <EmptyHeader>
              <EmptyTitle>{t("pluginMarket.utools.empty")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {result && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span aria-live="polite">
              {t("pluginMarket.utools.page", { count: result.total, page: result.page, pages })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading || result.page <= 1}
                onClick={() => setPage(result.page - 1)}
              >
                {t("pluginMarket.utools.previous")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading || result.page >= pages}
                onClick={() => setPage(result.page + 1)}
              >
                {t("pluginMarket.utools.next")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
