import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutGrid,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { LayerInstanceSummary, LayerTemplateSummary } from "../../../shared/layer-contract";
import { invoke, listen } from "../../platform/desktop";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Spinner } from "../../components/ui/spinner";
import { getErrorMessage } from "../notes/api";

export function DesktopWidgetManager({
  enabled = true,
  webEnabled = true,
  onChanged,
}: {
  enabled?: boolean;
  webEnabled?: boolean;
  onChanged?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const zh = i18n.resolvedLanguage?.startsWith("zh") ?? true;
  const text = (cn: string, en: string) => (zh ? cn : en);
  const [templates, setTemplates] = useState<LayerTemplateSummary[]>([]);
  const [instances, setInstances] = useState<LayerInstanceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notesMigrationError, setNotesMigrationError] = useState<string>();
  const active = useRef(false);
  const refreshRevision = useRef(0);
  const reload = useCallback(async () => {
    const revision = ++refreshRevision.current;
    try {
      const value = await invoke("layer_listTemplates", {});
      if (!active.current || revision !== refreshRevision.current) return;
      setTemplates(value.templates);
      setInstances(value.instances);
      setNotesMigrationError(value.notesMigrationError);
      setError(undefined);
    } catch (failure) {
      if (active.current && revision === refreshRevision.current) throw failure;
    }
  }, []);
  useEffect(() => {
    let current = true;
    active.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void reload()
        .catch((failure) => {
          if (current) setError(getErrorMessage(failure));
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    };
    const scheduleRefresh = () => {
      if (!current) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const subscriptions = (
      ["desktop-pins-changed", "plugins-changed", "config-changed"] as const
    ).map((name) =>
      listen(name, scheduleRefresh).catch((failure) => {
        if (current) setError(getErrorMessage(failure));
      }),
    );
    refresh();
    return () => {
      current = false;
      active.current = false;
      clearTimeout(timer);
      for (const subscription of subscriptions) void subscription.then((off) => off?.());
    };
  }, [enabled, webEnabled, reload]);
  const perform = async (id: string, operation: () => Promise<unknown>) => {
    setBusy(id);
    setError(undefined);
    try {
      await operation();
      await reload();
      onChanged?.();
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };
  const title = (instance: LayerInstanceSummary) =>
    instance.title ??
    templates.find(
      (template) =>
        template.pluginId === instance.pluginId &&
        template.widgetDefinitionId === instance.widgetDefinitionId,
    )?.title ??
    instance.widgetDefinitionId;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium">{text("桌面卡片", "Desktop cards")}</h3>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!enabled || !!busy}
            onClick={() => void perform("overlay", () => invoke("desktop_overlay_toggle"))}
          >
            <LayoutGrid data-icon="inline-start" />
            {t("desktopOverlay.open")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!enabled || !!busy || !instances.length}
            onClick={() => void perform("edit", () => invoke("layer_edit", {}))}
          >
            <SlidersHorizontal data-icon="inline-start" />
            {text("编辑桌面", "Arrange")}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={!!busy || loading}
            aria-label={text("刷新卡片", "Refresh cards")}
            onClick={() => void perform("reload", async () => {})}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {!enabled && (
        <Alert>
          <AlertDescription>
            {text("桌面卡片已关闭。", "Desktop cards are turned off.")}
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notesMigrationError && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {text("便签桌面迁移未完成：", "Notes desktop migration is incomplete: ")}
            {notesMigrationError}
          </AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {text("正在读取卡片…", "Loading cards…")}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {templates.map((template) => (
              <Card key={`${template.pluginId}:${template.widgetDefinitionId}`}>
                <CardHeader>
                  <CardTitle>{template.title}</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {text("活动实例", "Active instances")} {template.quota.active}/
                    {template.quota.limit}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      !enabled ||
                      !!busy ||
                      template.quota.active >= template.quota.limit ||
                      (template.kind === "web" && !webEnabled)
                    }
                    onClick={() =>
                      void perform(`create:${template.widgetDefinitionId}`, () =>
                        invoke("layer_create", {
                          pluginId: template.pluginId,
                          widgetDefinitionId: template.widgetDefinitionId,
                        }),
                      )
                    }
                  >
                    <Plus data-icon="inline-start" />
                    {text("添加", "Add")}
                  </Button>
                </CardContent>
                {template.kind === "web" && !webEnabled && (
                  <CardContent>
                    <p className="text-xs text-muted-foreground">
                      {text(
                        "开启独立网页卡片后可添加此模板。",
                        "Enable isolated web cards to add this template.",
                      )}
                    </p>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
          {!templates.length && !instances.length && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{text("暂无可用模板", "No card templates")}</EmptyTitle>
                <EmptyDescription>
                  {text(
                    "启用提供桌面卡片的插件后，可在这里添加。",
                    "Enable a plugin that provides desktop cards, then add one here.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {instances.map((instance) => {
            const id = instance.widgetInstanceId;
            const blocked = !!busy;
            const template = templates.find(
              (candidate) =>
                candidate.pluginId === instance.pluginId &&
                candidate.widgetDefinitionId === instance.widgetDefinitionId,
            );
            const retryId = `retry:${id}`;
            const screenshot =
              instance.pluginId === "spark233.screenshot" &&
              instance.widgetDefinitionId === "screenshot-pin";
            const canRetry =
              instance.status === "fault" &&
              enabled &&
              instance.visible &&
              (screenshot || (!!template && (template.kind !== "web" || webEnabled)));
            const details = instance as LayerInstanceSummary & {
              group?: "normal" | "top";
              inputMode?: "passive" | "interactive";
            };
            const statuses = {
              active: text("显示中", "Visible"),
              hidden: text("已隐藏", "Hidden"),
              suspended: text("已暂停", "Paused"),
              orphan: text("卡片不可用", "Card unavailable"),
              fault: text("需要重试", "Needs attention"),
            };
            return (
              <Card key={id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{title(instance)}</CardTitle>
                    <Badge variant="secondary">{statuses[instance.status]}</Badge>
                  </div>
                  {instance.reason && <CardDescription>{instance.reason}</CardDescription>}
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  {canRetry && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={blocked}
                      aria-label={t("desktopSettings.retryCard", { title: title(instance) })}
                      onClick={() =>
                        void perform(retryId, () => invoke("layer_retry", { widgetInstanceId: id }))
                      }
                    >
                      {busy === retryId ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
                      {t(busy === retryId ? "desktopSettings.retrying" : "desktopSettings.retry")}
                    </Button>
                  )}
                  <ToggleGroup
                    size="sm"
                    variant="outline"
                    value={[details.group ?? "normal"]}
                    disabled={blocked}
                    aria-label={text("置顶设置", "Stacking")}
                    onValueChange={(values) => {
                      const group = values[0];
                      if (group === "normal" || group === "top")
                        void perform(id, () =>
                          invoke("layer_update", { widgetInstanceId: id, patch: { group } }),
                        );
                    }}
                  >
                    <ToggleGroupItem value="normal">{text("普通", "Normal")}</ToggleGroupItem>
                    <ToggleGroupItem value="top">{text("置顶", "On top")}</ToggleGroupItem>
                  </ToggleGroup>
                  <ToggleGroup
                    size="sm"
                    variant="outline"
                    value={[details.inputMode ?? "passive"]}
                    disabled={blocked}
                    aria-label={text("鼠标行为", "Mouse behavior")}
                    onValueChange={(values) => {
                      const inputMode = values[0];
                      if (inputMode === "passive" || inputMode === "interactive")
                        void perform(id, () =>
                          invoke("layer_update", { widgetInstanceId: id, patch: { inputMode } }),
                        );
                    }}
                  >
                    <ToggleGroupItem value="passive">
                      {text("点击穿透", "Click through")}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="interactive">
                      {text("允许交互", "Interactive")}
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={blocked}
                    onClick={() =>
                      void perform(id, () =>
                        invoke("layer_update", {
                          widgetInstanceId: id,
                          patch: { visible: !instance.visible },
                        }),
                      )
                    }
                  >
                    {instance.visible ? text("隐藏", "Hide") : text("显示", "Show")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() =>
                      void perform(id, () => invoke("layer_remove", { widgetInstanceId: id }))
                    }
                  >
                    <Trash2 data-icon="inline-start" />
                    {text("移除", "Remove")}
                  </Button>
                  {busy === id && <Spinner />}
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
