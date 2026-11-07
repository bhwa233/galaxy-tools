import { showToast } from "../../components/Toast";
import { PluginIcon } from "./PluginIcon";
import { PluginShortcuts } from "./PluginShortcuts";
import { PluginConfiguration } from "./PluginConfiguration";
import { ApplicationsDialog } from "../applications/ApplicationsDialog";
import { prepareHostWindow } from "../windows/hostPreparation";
import { openSettingsWindow, type SettingsTarget } from "../settings/api";
import { SlidingButtonGroup } from "@/components/SlidingButtonGroup";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon, FolderOpenIcon, PackageIcon, RefreshCwIcon } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ManagementSurface";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownPreviewLazy } from "../markdown/MarkdownPreviewLazy";
import { PluginMarketSortControl } from "./PluginMarketSort";
import { UToolsCatalogList } from "./UToolsCatalogList";
import { PackageTaskList } from "./PackageTaskList";
import { UninstallPluginDialog } from "./UninstallPluginDialog";
import {
  pluginMarketSorts,
  sortPluginMarketEntries,
  type PluginMarketSort,
} from "../../../shared/plugin-market";
import {
  activatePlugin,
  cancelPluginInstall,
  cancelPluginPackageTask,
  checkPluginUpdates,
  confirmPluginInstall,
  importPluginPackage,
  importPluginDirectory,
  getPluginReleaseNotes,
  listPlugins,
  preparePluginUpdate,
  prepareBundledPlugin,
  prepareRegistryPlugin,
  prepareUToolsPlugin,
  setPluginEnabled,
  uninstallPlugin,
  watchPluginsChanged,
  watchPluginPackageTasks,
} from "./api";
import type {
  PackageTaskSnapshot,
  PluginManagementState,
  PluginReleaseNotes,
  PluginSummary,
} from "./types";
import { getErrorMessage } from "../../platform/errors";

const capabilityLabels: Record<PluginSummary["capabilities"][number], string> = {
  storage: "插件私有存储",
  windows: "插件窗口",
  shortcuts: "全局快捷键",
  tray: "更新本插件托盘菜单状态",
  notifications: "系统通知",
  network: "网络访问",
  "files.read": "读取授权文件",
  "files.write": "写入授权文件",
  "clipboard.read": "读取剪贴板",
  "clipboard.write": "写入剪贴板",
  "clipboard.watch": "监听剪贴板",
  "native.process": "运行原生程序",
  "node.backend": "运行 Node 后台",
  "search.index": "搜索索引",
  commands: "调用其他插件的公开命令",
};

const marketPreferenceKey = "spark233.plugin-market.preferences.v1";
type MarketSource = "spark233" | "utools";
interface MarketPreferences {
  source: MarketSource;
  sort: Record<MarketSource | "installed", PluginMarketSort>;
}
function readMarketPreferences(): MarketPreferences {
  const defaults: MarketPreferences = {
    source: "spark233",
    sort: { spark233: "auto", utools: "auto", installed: "auto" },
  };
  // Match the search workspace's optional local preferences; storage failures
  // must never prevent discovery or installation.
  try {
    const saved = JSON.parse(localStorage.getItem(marketPreferenceKey) ?? "null");
    if (!saved || saved.version !== 1) return defaults;
    if (saved.source === "utools") defaults.source = "utools";
    for (const source of ["spark233", "utools", "installed"] as const) {
      const value = saved.sort?.[source];
      if (
        pluginMarketSorts.includes(value) &&
        (source === "utools" || (value !== "rating" && value !== "voters"))
      )
        defaults.sort[source] = value;
    }
  } catch {
    /* A malformed or unavailable preference uses the default order. */
  }
  return defaults;
}

export interface PluginManagementDialogProps {
  mode?: "configuration" | "market";
  onNavigate?: (target: SettingsTarget) => Promise<void>;
  pluginId?: string;
  initialTab?: string;
  embedded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialState?: PluginManagementState;
  loadState?: (refresh?: boolean) => Promise<PluginManagementState>;
}

// Compose the installed registry primitives and existing desktop IPC boundary;
// state here is only form input and the host's authoritative management snapshot.
export function PluginManagementDialog({
  open,
  onOpenChange,
  embedded = false,
  pluginId,
  initialTab = "config",
  mode = "market",
  onNavigate = openSettingsWindow,
  initialState,
  loadState = listPlugins,
}: PluginManagementDialogProps) {
  const { t, i18n } = useTranslation();
  const [selectedPlugin, setSelectedPlugin] = useState<string | undefined>(
    pluginId ?? initialState?.plugins[0]?.pluginId,
  );
  const [pluginFilter, setPluginFilter] = useState("");
  const [marketPreferences, setMarketPreferences] = useState(readMarketPreferences);
  const [utoolsVisited, setUToolsVisited] = useState(() => marketPreferences.source === "utools");
  const requestedPluginCard = useRef<HTMLDivElement>(null);
  const scrolledPlugin = useRef<string | undefined>(undefined);
  const rememberMarket = (next: MarketPreferences) => {
    setMarketPreferences(next);
    try {
      localStorage.setItem(marketPreferenceKey, JSON.stringify({ version: 1, ...next }));
    } catch {
      /* Sorting remains usable when browser storage is blocked. */
    }
  };
  const [detailTab, setDetailTab] = useState(initialTab === "info" ? "config" : initialTab);
  const [marketTab, setMarketTab] = useState<"discover" | "installed" | "tasks">(
    pluginId ? "installed" : "discover",
  );
  useEffect(() => {
    if (pluginId) {
      setSelectedPlugin(pluginId);
      setDetailTab(initialTab === "info" ? "config" : initialTab);
      if (mode === "market") setMarketTab("installed");
    }
  }, [pluginId, initialTab, mode]);
  const navigatePlugin = async (id: string) => {
    try {
      await prepareHostWindow();
      setSelectedPlugin(id);
      setDetailTab("config");
    } catch (value) {
      // The editor keeps its own prompt; say why the click did nothing.
      setError(errorText(value));
    }
  };
  const initialSnapshot = useRef(initialState);
  const [state, setState] = useState<PluginManagementState | null>(initialState ?? null);
  useEffect(() => {
    if (!open) {
      scrolledPlugin.current = undefined;
      return;
    }
    if (
      mode === "market" &&
      marketTab === "installed" &&
      pluginId &&
      scrolledPlugin.current !== pluginId &&
      requestedPluginCard.current
    ) {
      requestedPluginCard.current.scrollIntoView({ block: "nearest" });
      scrolledPlugin.current = pluginId;
    }
  }, [mode, marketTab, pluginId, state?.plugins, open]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [activating, setActivating] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [registry, setRegistry] = useState("");
  const [channel, setChannel] = useState("");
  const registryPreparationKey = `registry:${JSON.stringify([name.trim(), registry.trim(), channel.trim()])}`;
  const [trust, setTrust] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<PluginSummary>();
  const [deleteData, setDeleteData] = useState(false);
  const [tasks, setTasks] = useState<PackageTaskSnapshot[]>([]);
  const taskSnapshots = useRef(new Map<string, PackageTaskSnapshot>());
  const [preparing, setPreparing] = useState<string[]>([]);
  const preparations = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<string[]>([]);
  const cancellations = useRef(new Set<string>());
  const [releaseNotes, setReleaseNotes] = useState<Record<string, PluginReleaseNotes>>({});
  const [loadingNotes, setLoadingNotes] = useState<string[]>([]);
  const noteRequests = useRef(new Set<string>());
  const active = useRef(false);
  const request = useRef(0);
  const operating = useRef(false);
  const commandTasks = useRef(new Set<string>());
  const errorText = (value: unknown) => getErrorMessage(value);

  // Merge the host's immutable task snapshots before applying a full list: an
  // earlier list response must not overwrite a newer progress/cancel event.
  const mergeTasks = useCallback((incoming: PackageTaskSnapshot[]) => {
    for (const task of incoming) {
      const previous = taskSnapshots.current.get(task.taskId);
      if (!previous || task.revision > previous.revision) {
        taskSnapshots.current.set(task.taskId, task);
      }
    }
    // Match the host's bounded history without evicting active work, a retained
    // failed preview, or recovery state received after an older list snapshot.
    for (const [taskId, task] of taskSnapshots.current) {
      if (taskSnapshots.current.size <= 64) break;
      if (
        task.stage === "completed" ||
        task.stage === "cancelled" ||
        (task.stage === "failed" && !task.previewId)
      )
        taskSnapshots.current.delete(taskId);
    }
    const merged = [...taskSnapshots.current.values()];
    setTasks(merged);
    return merged;
  }, []);

  const refresh = useCallback(
    async (force = true) => {
      const current = ++request.current;
      try {
        const snapshot = await loadState(force);
        if (active.current && current === request.current) {
          setState({ ...snapshot, tasks: mergeTasks(snapshot.tasks ?? []) });
          setSelectedPlugin((current) =>
            current && snapshot.plugins.some((plugin) => plugin.pluginId === current)
              ? current
              : snapshot.plugins[0]?.pluginId,
          );
        }
      } catch (value) {
        if (active.current && current === request.current) setError(errorText(value));
      }
    },
    [mergeTasks, loadState],
  );

  useEffect(() => {
    if (!open) return;
    active.current = true;
    const unlisten: (() => void)[] = [];
    let closed = false;
    setError(undefined);
    setState(initialSnapshot.current ?? null);
    taskSnapshots.current.clear();
    setTasks([]);
    if (initialSnapshot.current) mergeTasks(initialSnapshot.current.tasks ?? []);
    // Install both listeners before requesting the initial state. Each listener
    // cleans itself up even if the dialog closes while subscription is pending.
    const subscribe = async () => {
      const subscriptions = await Promise.allSettled([
        watchPluginsChanged(() => {
          if (!closed) void refresh();
        }),
        watchPluginPackageTasks((task) => {
          if (closed) return;
          const previous = taskSnapshots.current.get(task.taskId);
          if (previous && previous.revision >= task.revision) return;
          mergeTasks([task]);
          if (
            previous?.stage !== task.stage &&
            [
              "awaiting-confirmation",
              "completed",
              "cancelled",
              "failed",
              "recovery-required",
            ].includes(task.stage)
          )
            void refresh();
        }),
      ]);
      for (const subscription of subscriptions) {
        if (subscription.status === "fulfilled") {
          if (closed) subscription.value();
          else unlisten.push(subscription.value);
        } else if (!closed) setError(errorText(subscription.reason));
      }
      if (!closed) await refresh(false);
    };
    void subscribe();
    return () => {
      closed = true;
      active.current = false;
      request.current++;
      for (const stop of unlisten) stop();
    };
  }, [open, refresh, mergeTasks]);

  const prepare = async (key: string, action: () => Promise<unknown>) => {
    if (preparations.current.has(key)) return;
    preparations.current.add(key);
    setPreparing([...preparations.current]);
    setMarketTab("tasks");
    setError(undefined);
    try {
      // Cancellation resolves undefined; it is a normal task terminal state.
      await action();
    } catch (value) {
      if (active.current) setError(errorText(value));
    } finally {
      preparations.current.delete(key);
      setPreparing([...preparations.current]);
      if (active.current) await refresh();
    }
  };

  const cancelTask = async (taskId: string) => {
    if (cancellations.current.has(taskId)) return;
    cancellations.current.add(taskId);
    setCancelling([...cancellations.current]);
    try {
      const snapshot = await cancelPluginPackageTask(taskId);
      if (active.current) mergeTasks([snapshot]);
    } catch (value) {
      if (active.current) setError(errorText(value));
    } finally {
      cancellations.current.delete(taskId);
      setCancelling([...cancellations.current]);
      if (active.current) await refresh();
    }
  };

  const loadReleaseNotes = async (plugin: PluginSummary) => {
    const key = `${plugin.pluginId}@${plugin.version}`;
    if (noteRequests.current.has(key)) return;
    noteRequests.current.add(key);
    setLoadingNotes([...noteRequests.current]);
    try {
      const notes = await getPluginReleaseNotes(plugin.pluginId);
      setReleaseNotes((current) => ({ ...current, [key]: notes }));
    } catch (value) {
      setReleaseNotes((current) => ({
        ...current,
        [key]: { status: "error", message: errorText(value) },
      }));
    } finally {
      noteRequests.current.delete(key);
      setLoadingNotes([...noteRequests.current]);
    }
  };

  const renderReleaseNotes = (notes: PluginReleaseNotes | undefined) => (
    <div className="mt-3 flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t("plugins.releaseNotes.source")}</p>
      {notes?.status === "available" ? (
        <div className="max-h-64 min-w-0 overflow-auto rounded-md border p-3 text-sm break-words">
          <MarkdownPreviewLazy
            content={notes.content ?? ""}
            renderHtml={false}
            imageDisplay="hidden"
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(
            !notes
              ? "plugins.releaseNotes.unavailable"
              : notes.status === "missing"
                ? "plugins.releaseNotes.missing"
                : "plugins.releaseNotes.error",
          )}
        </p>
      )}
      {notes?.status === "error" && notes.message && (
        <p className="text-xs break-words text-muted-foreground">{notes.message}</p>
      )}
    </div>
  );

  const run = async (
    label: string,
    action: () => Promise<unknown>,
    success?: string,
  ): Promise<boolean> => {
    if (operating.current) return false;
    try {
      await prepareHostWindow();
    } catch (value) {
      setError(errorText(value));
      return false;
    }
    operating.current = true;
    setBusy(label);
    setError(undefined);
    try {
      await action();
      if (active.current && success) showToast(success, "success");
      await refresh();
      return true;
    } catch (value) {
      setError(errorText(value));
      await refresh();
      return false;
    } finally {
      operating.current = false;
      setBusy(undefined);
    }
  };
  const disabled = !!busy;
  const launch = async (pluginId: string, commandId?: string) => {
    if (commandTasks.current.has(pluginId)) return;
    commandTasks.current.add(pluginId);
    setActivating([...commandTasks.current]);
    setError(undefined);
    try {
      await activatePlugin(pluginId, commandId);
    } catch (value) {
      setError(errorText(value));
    } finally {
      commandTasks.current.delete(pluginId);
      setActivating([...commandTasks.current]);
      await refresh();
    }
  };
  const statusLabel = (plugin: PluginSummary) =>
    plugin.lastError
      ? t("plugins.status.error", { defaultValue: "需要处理" })
      : !plugin.enabled
        ? t("plugins.status.disabled", { defaultValue: "已停用" })
        : plugin.status === "active"
          ? t("plugins.status.active", { defaultValue: "运行中" })
          : plugin.status === "preparing"
            ? t("plugins.status.preparing", { defaultValue: "正在保存" })
            : plugin.status === "prepared"
              ? t("plugins.status.prepared", { defaultValue: "已保存，等待停止" })
              : plugin.status === "releasing"
                ? t("plugins.status.releasing", { defaultValue: "正在停止" })
                : plugin.status === "released"
                  ? t("plugins.status.released", { defaultValue: "已停止" })
                  : t("plugins.status.enabled", { defaultValue: "已启用" });

  const visiblePlugins =
    mode === "market"
      ? sortPluginMarketEntries(
          state?.plugins ?? [],
          marketPreferences.sort.installed,
          pluginFilter,
        )
      : (state?.plugins ?? []).filter((plugin) =>
          `${plugin.displayName} ${plugin.pluginId}`
            .toLocaleLowerCase()
            .includes(pluginFilter.trim().toLocaleLowerCase()),
        );
  const visiblePluginOrder = new Map(
    visiblePlugins.map((plugin, index) => [plugin.pluginId, index]),
  );
  const visibleCatalog = sortPluginMarketEntries(
    state?.catalog ?? [],
    marketPreferences.sort.spark233,
    pluginFilter,
  );
  const sortContext = marketTab === "installed" ? "installed" : marketPreferences.source;
  const updateIssues = state?.updateIssues ?? [];
  const unpublishedUpdates = updateIssues.filter((issue) => issue.reason === "notPublished");
  const failedUpdateChecks = updateIssues.filter((issue) => issue.reason === "failed");
  return (
    <>
      <Dialog
        embedded={embedded}
        open={open}
        onOpenChange={(value) => {
          if (!removing) onOpenChange(value);
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
          <DialogHeader className="pr-7">
            <DialogTitle>
              {mode === "configuration" ? t("pluginConfig.title") : t("plugins.title")}
            </DialogTitle>
            <DialogDescription>
              {mode === "configuration"
                ? t("pluginConfig.description")
                : t("plugins.description", {
                    defaultValue: "导入插件后确认安装；更新只提示，由你决定何时安装。",
                  })}
            </DialogDescription>
          </DialogHeader>
          {mode === "market" && (
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <SlidingButtonGroup
                value={marketTab}
                options={(["discover", "installed", "tasks"] as const).map((value) => ({
                  value,
                  label: t(`pluginMarket.tabs.${value}`),
                }))}
                onChange={setMarketTab}
                className="min-w-72"
              />
              {marketTab !== "tasks" && (
                <Input
                  className="ml-auto w-56"
                  value={pluginFilter}
                  maxLength={256}
                  aria-label={t("pluginConfig.findPlugin")}
                  placeholder={t("pluginConfig.findPlugin")}
                  onChange={(event) => setPluginFilter(event.target.value)}
                />
              )}
            </div>
          )}
          {mode === "market" && marketTab !== "tasks" && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              {marketTab === "discover" && (
                <SlidingButtonGroup
                  value={marketPreferences.source}
                  options={(["spark233", "utools"] as const).map((value) => ({
                    value,
                    label: t(`pluginMarket.sources.${value}`),
                  }))}
                  onChange={(value) => {
                    if (value !== "spark233" && value !== "utools") return;
                    if (value === "utools") setUToolsVisited(true);
                    rememberMarket({ ...marketPreferences, source: value });
                  }}
                />
              )}
              <div className="ml-auto">
                <PluginMarketSortControl
                  value={marketPreferences.sort[sortContext]}
                  query={pluginFilter}
                  ratings={sortContext === "utools"}
                  onChange={(value) =>
                    rememberMarket({
                      ...marketPreferences,
                      sort: { ...marketPreferences.sort, [sortContext]: value },
                    })
                  }
                />
              </div>
            </div>
          )}
          <div className="flex min-h-0 flex-1 gap-6 overflow-hidden">
            {mode === "configuration" && (
              <nav
                aria-label={t("pluginConfig.installed")}
                className="flex min-h-0 min-w-0 w-48 shrink-0 flex-col gap-2 border-r pr-4"
              >
                <Input
                  className="shrink-0"
                  aria-label={t("pluginConfig.findPlugin")}
                  placeholder={t("pluginConfig.findPlugin")}
                  value={pluginFilter}
                  onChange={(event) => setPluginFilter(event.target.value)}
                />
                <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto">
                  {visiblePlugins?.map((plugin) => (
                    <Button
                      key={plugin.pluginId}
                      variant={selectedPlugin === plugin.pluginId ? "secondary" : "ghost"}
                      className="h-auto w-full min-w-0 justify-start whitespace-normal py-3 text-left"
                      onClick={() => {
                        void navigatePlugin(plugin.pluginId);
                      }}
                    >
                      <PluginIcon
                        icon={plugin.icon}
                        monochrome={plugin.iconMonochrome}
                        className="size-5 shrink-0 text-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" title={plugin.displayName}>
                          {plugin.displayName}
                        </span>
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={statusLabel(plugin)}
                        >
                          {statusLabel(plugin)}
                        </span>
                      </span>
                    </Button>
                  ))}
                  {visiblePlugins?.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      {t("commandSettings.noPlugins")}
                    </p>
                  )}
                </div>
              </nav>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-1 *:shrink-0">
              {(error || state?.error) && (
                <Alert variant="destructive">
                  <AlertTitle>{t("plugins.error", { defaultValue: "操作未完成" })}</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2">
                    <p>
                      {t("plugins.errorHint", {
                        defaultValue: "展开详细信息查看原因，再重试相关操作。",
                      })}
                    </p>
                    <details key={error || state?.error}>
                      <summary className="cursor-pointer">
                        {t("plugins.errorDetails", { defaultValue: "查看详细信息" })}
                      </summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
                        {error || state?.error}
                      </pre>
                    </details>
                  </AlertDescription>
                </Alert>
              )}
              {(busy || preparing.length > 0 || activating.length > 0) && (
                <Alert aria-live="polite">
                  <Spinner />
                  <AlertTitle>
                    {busy ||
                      (preparing.length > 0
                        ? t("plugins.preparing", { defaultValue: "正在准备安装预览" })
                        : t("plugins.commandRunning", { defaultValue: "插件命令正在运行" }))}
                  </AlertTitle>
                  <AlertDescription>
                    {busy || preparing.length > 0
                      ? t("plugins.working", { defaultValue: "正在处理，请稍候。" })
                      : t("plugins.commandRunningHint", {
                          defaultValue: "你仍可以停用插件；宿主会先请求保存并取消任务。",
                        })}
                  </AlertDescription>
                </Alert>
              )}

              <div
                hidden={mode !== "market" || marketTab === "installed"}
                className="flex flex-col gap-4"
              >
                {marketTab === "tasks" && tasks.length > 0 && (
                  <PackageTaskList
                    tasks={tasks}
                    cancelling={cancelling}
                    onCancel={(taskId) => void cancelTask(taskId)}
                  />
                )}

                {marketTab === "tasks" && !tasks.length && !state?.pending.length && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("pluginMarket.noTasks")}
                  </p>
                )}
                {utoolsVisited && mode === "market" && (
                  <div hidden={marketTab !== "discover" || marketPreferences.source !== "utools"}>
                    <UToolsCatalogList
                      onPrepare={(id) =>
                        void prepare(`utools:${id}`, () => prepareUToolsPlugin(id))
                      }
                      key={`${marketPreferences.sort.utools}:${pluginFilter}`}
                      active={
                        open && marketTab === "discover" && marketPreferences.source === "utools"
                      }
                      query={pluginFilter}
                      sort={marketPreferences.sort.utools}
                    />
                  </div>
                )}
                {marketTab === "discover" &&
                  marketPreferences.source === "spark233" &&
                  !!state?.catalog.length && (
                    <Card size="sm">
                      <CardHeader>
                        <CardTitle>{t("plugins.catalog.title")}</CardTitle>
                        <CardDescription>{t("plugins.catalog.description")}</CardDescription>
                      </CardHeader>
                      <CardContent
                        className="flex flex-col gap-3"
                        role="list"
                        aria-label={t("plugins.catalog.title")}
                      >
                        {visibleCatalog.map((item) => (
                          <div
                            key={item.pluginId}
                            role="listitem"
                            aria-label={item.displayName}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                          >
                            <div className="flex min-w-0 flex-col gap-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <PluginIcon
                                  icon={item.icon}
                                  monochrome={item.iconMonochrome}
                                  className="size-5 shrink-0"
                                />
                                <span className="text-sm font-medium">{item.displayName}</span>
                                <Badge variant="outline">{item.version}</Badge>
                              </div>
                              <span className="break-all text-xs text-muted-foreground">
                                {item.packageName}
                              </span>
                              {item.installedVersion && (
                                <span className="text-xs text-muted-foreground">
                                  {t("plugins.catalog.currentVersion", {
                                    version: item.installedVersion,
                                  })}
                                </span>
                              )}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                disabled ||
                                preparing.includes(`bundled:${item.pluginId}`) ||
                                !item.canPrepare
                              }
                              onClick={() => {
                                void prepare(`bundled:${item.pluginId}`, () =>
                                  prepareBundledPlugin(item.pluginId),
                                );
                              }}
                            >
                              {item.pending
                                ? t("plugins.pending")
                                : item.canPrepare
                                  ? t("plugins.catalog.prepare")
                                  : t("plugins.catalog.installed")}
                            </Button>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                {marketTab === "discover" && marketPreferences.source === "spark233" && (
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>{t("plugins.add.title", { defaultValue: "添加插件" })}</CardTitle>
                      <CardDescription>
                        {t("plugins.add.description", {
                          defaultValue: "支持 .tgz、npm 包及 spark233 / uTools 预构建目录。",
                        })}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={disabled || preparing.includes("import")}
                          onClick={() => {
                            void prepare("import", importPluginPackage);
                          }}
                        >
                          <DownloadIcon data-icon="inline-start" />
                          {t("plugins.import", { defaultValue: "导入本地 .tgz" })}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={disabled || preparing.includes("directory")}
                          onClick={() => {
                            void prepare("directory", importPluginDirectory);
                          }}
                        >
                          <FolderOpenIcon data-icon="inline-start" />
                          {t("plugins.importDirectory")}
                        </Button>
                      </div>
                      <form
                        id="spark233-plugin-source"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void prepare(registryPreparationKey, () =>
                            prepareRegistryPlugin({
                              name: name.trim(),
                              ...(registry.trim() ? { registry: registry.trim() } : {}),
                              ...(channel.trim() ? { channel: channel.trim() } : {}),
                            }),
                          );
                        }}
                      >
                        <FieldGroup className="gap-3">
                          <Field data-disabled={disabled}>
                            <FieldLabel htmlFor="plugin-package-name">
                              {t("plugins.packageName", { defaultValue: "npm 包名" })}
                            </FieldLabel>
                            <Input
                              id="plugin-package-name"
                              autoComplete="off"
                              placeholder="@scope/plugin-name"
                              value={name}
                              onChange={(event) => setName(event.target.value)}
                              required
                              maxLength={214}
                              disabled={disabled}
                            />
                          </Field>
                          <FieldGroup className="gap-3 sm:flex-row">
                            <Field data-disabled={disabled}>
                              <FieldLabel htmlFor="plugin-registry">
                                {t("plugins.registry", { defaultValue: "Registry（可选）" })}
                              </FieldLabel>
                              <Input
                                id="plugin-registry"
                                type="url"
                                placeholder="https://registry.npmjs.org/"
                                value={registry}
                                onChange={(event) => setRegistry(event.target.value)}
                                maxLength={2048}
                                disabled={disabled}
                              />
                              <FieldDescription>
                                {t("plugins.registryHint", {
                                  defaultValue: "留空使用 npm 官方源，其他源需 HTTPS。",
                                })}
                              </FieldDescription>
                            </Field>
                            <Field data-disabled={disabled}>
                              <FieldLabel htmlFor="plugin-channel">
                                {t("plugins.channel", { defaultValue: "更新通道（可选）" })}
                              </FieldLabel>
                              <Input
                                id="plugin-channel"
                                placeholder="latest"
                                value={channel}
                                onChange={(event) => setChannel(event.target.value)}
                                maxLength={128}
                                disabled={disabled}
                              />
                              <FieldDescription>
                                {t("plugins.channelHint", {
                                  defaultValue: "留空使用 latest 稳定通道。",
                                })}
                              </FieldDescription>
                            </Field>
                          </FieldGroup>
                        </FieldGroup>
                      </form>
                    </CardContent>
                    <CardFooter>
                      <Button
                        form="spark233-plugin-source"
                        type="submit"
                        size="sm"
                        disabled={
                          disabled || preparing.includes(registryPreparationKey) || !name.trim()
                        }
                      >
                        {t("plugins.prepare", { defaultValue: "准备安装预览" })}
                      </Button>
                    </CardFooter>
                  </Card>
                )}

                {marketTab === "tasks" && !!state?.pending.length && (
                  <section
                    className="flex flex-col gap-3"
                    aria-label={t("plugins.pending", { defaultValue: "待确认安装" })}
                  >
                    <h3 className="text-sm font-medium">
                      {t("plugins.pending", { defaultValue: "待确认安装" })}{" "}
                      <Badge variant="secondary">{state.pending.length}</Badge>
                    </h3>
                    {state.pending.map((preview) => (
                      <Card key={preview.previewId} size="sm">
                        <CardHeader>
                          <CardTitle>
                            {preview.metadata.spark233.translations?.[
                              i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN"
                            ]?.displayName ?? preview.metadata.spark233.displayName}{" "}
                            <Badge variant="outline">{preview.metadata.version}</Badge>
                            {preview.metadata.spark233.compatibility && (
                              <Badge variant="secondary">uTools</Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="break-all">
                            {preview.metadata.name} ·{" "}
                            {preview.source.kind === "directory"
                              ? t("plugins.directoryPackage")
                              : preview.source.kind === "file"
                                ? t("plugins.localPackage", { defaultValue: "本地包" })
                                : preview.source.kind === "utools"
                                  ? t("pluginMarket.utools.storePackage")
                                  : t("plugins.registryPackage", { defaultValue: "Registry 包" })}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                          {preview.change && (
                            <Alert>
                              <AlertDescription>
                                {t(`pluginMarket.utools.change.${preview.change}`)}
                              </AlertDescription>
                            </Alert>
                          )}
                          {preview.warnings?.map((warning) => (
                            <Alert key={warning}>
                              <AlertDescription>{warning}</AlertDescription>
                            </Alert>
                          ))}
                          {preview.metadata.spark233.compatibility && (
                            <p className="text-sm text-muted-foreground">
                              {t("plugins.utoolsLocalOnly")}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                            <span>
                              {preview.currentVersion
                                ? t("plugins.currentVersion", { version: preview.currentVersion })
                                : t("plugins.notInstalled")}
                            </span>
                            <span>
                              {t("plugins.candidateVersion", { version: preview.metadata.version })}
                            </span>
                          </div>
                          <p className="break-all text-sm text-muted-foreground">
                            {t("plugins.source", { defaultValue: "来源" })}:
                            {preview.source.location}
                            {preview.source.registry && (
                              <>
                                <br />
                                {preview.source.registry} · {preview.source.channel ?? "latest"}
                              </>
                            )}
                          </p>
                          {preview.metadata.description && (
                            <p className="text-sm">{preview.metadata.description}</p>
                          )}
                          <details className="min-w-0 text-sm">
                            <summary className="cursor-pointer">
                              {t("plugins.releaseNotes.candidate")}
                            </summary>
                            {renderReleaseNotes(preview.releaseNotes)}
                            {preview.releaseNotes?.status === "error" && (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {t("plugins.releaseNotes.prepareAgain")}
                              </p>
                            )}
                          </details>
                          <div
                            className="flex flex-wrap gap-1.5"
                            aria-label={t("plugins.capabilities", { defaultValue: "申请能力" })}
                          >
                            {preview.metadata.spark233.capabilities.length ? (
                              preview.metadata.spark233.capabilities.map((capability) => (
                                <Badge key={capability} variant="secondary">
                                  {t(`plugins.capability.${capability}`, {
                                    defaultValue: capabilityLabels[capability],
                                  })}
                                </Badge>
                              ))
                            ) : (
                              <Badge variant="outline">
                                {t("plugins.noCapabilities", { defaultValue: "未申请宿主能力" })}
                              </Badge>
                            )}
                          </div>
                          <details className="text-sm">
                            <summary className="cursor-pointer">
                              {t("plugins.manifest", { defaultValue: "查看完整清单与校验信息" })}
                            </summary>
                            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
                              {JSON.stringify(
                                { ...preview.metadata, integrity: preview.integrity },
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                          {preview.requiresNativeTrust && (
                            <>
                              <Alert>
                                <AlertTitle>
                                  {t("plugins.native.title", {
                                    defaultValue: "此插件可运行 Node 或原生代码",
                                  })}
                                </AlertTitle>
                                <AlertDescription>
                                  {t("plugins.native.description", {
                                    defaultValue:
                                      "这类代码拥有当前用户的完整系统权限，可直接访问文件、网络及其他用户可访问的资源，不受网页能力清单限制。进程隔离不是权限沙箱，请只安装你信任的来源。",
                                  })}
                                </AlertDescription>
                              </Alert>
                              <FieldGroup>
                                <Field orientation="horizontal" data-disabled={disabled}>
                                  <Checkbox
                                    id={`trust-${preview.previewId}`}
                                    checked={trust[preview.previewId] === true}
                                    onCheckedChange={(checked) =>
                                      setTrust((current) => ({
                                        ...current,
                                        [preview.previewId]: checked === true,
                                      }))
                                    }
                                    disabled={disabled}
                                  />
                                  <FieldContent>
                                    <FieldLabel htmlFor={`trust-${preview.previewId}`}>
                                      {t("plugins.native.confirm", {
                                        defaultValue: "我信任此来源，并允许运行 Node / 原生代码",
                                      })}
                                    </FieldLabel>
                                  </FieldContent>
                                </Field>
                              </FieldGroup>
                            </>
                          )}
                        </CardContent>
                        <CardFooter className="flex-wrap gap-2">
                          <Button
                            size="sm"
                            disabled={
                              disabled ||
                              (preview.taskId &&
                                (cancelling.includes(preview.taskId) ||
                                  tasks.some(
                                    (task) =>
                                      task.taskId === preview.taskId &&
                                      task.stage !== "awaiting-confirmation" &&
                                      task.stage !== "failed",
                                  ))) ||
                              (preview.requiresNativeTrust && trust[preview.previewId] !== true)
                            }
                            onClick={() => {
                              void run(
                                t("plugins.installing", { defaultValue: "正在安装并验证插件" }),
                                () =>
                                  confirmPluginInstall(
                                    preview.previewId,
                                    preview.requiresNativeTrust &&
                                      trust[preview.previewId] === true,
                                  ),
                                t(
                                  preview.currentVersion
                                    ? "notifications.updated"
                                    : "notifications.installed",
                                  { name: preview.metadata.spark233.displayName },
                                ),
                              );
                            }}
                          >
                            {preview.change === "source"
                              ? t("pluginMarket.utools.bindSource")
                              : t("plugins.confirmInstall", { defaultValue: "确认安装" })}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              preview.taskId
                                ? cancelling.includes(preview.taskId) ||
                                  tasks.some(
                                    (task) =>
                                      task.taskId === preview.taskId &&
                                      (task.stage === "recovery-required" ||
                                        (!task.cancelable &&
                                          !(
                                            task.stage === "failed" &&
                                            task.previewId === preview.previewId
                                          ))),
                                  )
                                : disabled
                            }
                            onClick={() => {
                              if (preview.taskId) void cancelTask(preview.taskId);
                              else
                                void run(
                                  t("plugins.canceling", { defaultValue: "正在取消待确认安装" }),
                                  () => cancelPluginInstall(preview.previewId),
                                );
                            }}
                          >
                            {t("plugins.cancel", { defaultValue: "取消安装" })}
                          </Button>
                        </CardFooter>
                      </Card>
                    ))}
                  </section>
                )}
              </div>
              <section
                hidden={mode === "market" && marketTab !== "installed"}
                className="flex flex-col gap-3"
                aria-label={t("plugins.installed", { defaultValue: "已安装插件" })}
              >
                <div
                  hidden={mode === "configuration"}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <h3 className="text-sm font-medium">
                    {t("plugins.installed", { defaultValue: "已安装插件" })}
                  </h3>
                  {mode === "market" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled || state?.checking}
                      onClick={() => {
                        void run(
                          t("plugins.checking", { defaultValue: "正在检查插件更新" }),
                          checkPluginUpdates,
                        );
                      }}
                    >
                      {state?.checking ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      {t("plugins.checkUpdates", { defaultValue: "检查更新" })}
                    </Button>
                  )}
                </div>
                {mode === "market" && state?.lastChecked && (
                  <p className="text-xs text-muted-foreground">
                    {t("plugins.lastChecked", { defaultValue: "上次检查" })}:
                    {new Date(state.lastChecked).toLocaleString(i18n.resolvedLanguage)}
                  </p>
                )}
                {mode === "market" && updateIssues.length > 0 && (
                  <Alert role="status">
                    <AlertTitle>{t("plugins.updateStatus.title")}</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      {unpublishedUpdates.length > 0 && (
                        <p>
                          {t("plugins.updateStatus.notPublished", {
                            count: unpublishedUpdates.length,
                          })}
                        </p>
                      )}
                      {failedUpdateChecks.length > 0 && <p>{t("plugins.updateStatus.failed")}</p>}
                      <details>
                        <summary className="cursor-pointer">{t("plugins.errorDetails")}</summary>
                        <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto text-xs">
                          {updateIssues.map((issue, index) => (
                            <li
                              key={`${issue.pluginId ?? "check"}:${issue.reason}:${index}`}
                              className="break-words"
                            >
                              <span>
                                {state?.plugins.find((plugin) => plugin.pluginId === issue.pluginId)
                                  ?.displayName ??
                                  issue.pluginId ??
                                  t("plugins.updateStatus.check")}
                              </span>
                              {issue.message && (
                                <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                                  {issue.message}
                                </pre>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </AlertDescription>
                  </Alert>
                )}
                {!state && !error && (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia>
                        <Spinner />
                      </EmptyMedia>
                      <EmptyTitle>
                        {t("plugins.loading", { defaultValue: "正在读取插件状态" })}
                      </EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
                {state && !state.plugins.length && (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <PackageIcon />
                      </EmptyMedia>
                      <EmptyTitle>
                        {t("plugins.empty.title", { defaultValue: "尚未安装插件" })}
                      </EmptyTitle>
                      <EmptyDescription>
                        {t("plugins.empty.description", {
                          defaultValue: "从本地包或明确的 npm 来源添加插件，确认后即可使用。",
                        })}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {mode === "market" && !!state?.plugins.length && !visiblePlugins?.length && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {t("commandSettings.noPlugins")}
                  </p>
                )}
                {state?.plugins
                  .filter((plugin) =>
                    mode === "configuration"
                      ? plugin.pluginId === selectedPlugin
                      : visiblePluginOrder.has(plugin.pluginId),
                  )
                  .sort((a, b) =>
                    mode === "market"
                      ? visiblePluginOrder.get(a.pluginId)! - visiblePluginOrder.get(b.pluginId)!
                      : 0,
                  )
                  .map((plugin) => {
                    const update = state?.updates.find((item) => item.pluginId === plugin.pluginId);
                    const notesKey = `${plugin.pluginId}@${plugin.version}`;
                    const notes = releaseNotes[notesKey] ?? plugin.releaseNotes;
                    const notesLoading = loadingNotes.includes(notesKey);
                    return (
                      <Card
                        key={plugin.pluginId}
                        size="sm"
                        ref={plugin.pluginId === pluginId ? requestedPluginCard : undefined}
                      >
                        <CardHeader>
                          <CardTitle className="flex flex-wrap items-center gap-2">
                            <PluginIcon
                              icon={plugin.icon}
                              monochrome={plugin.iconMonochrome}
                              className="size-5 shrink-0 text-primary"
                            />
                            {plugin.displayName}
                            <Badge
                              variant={
                                plugin.lastError
                                  ? "destructive"
                                  : plugin.enabled
                                    ? "secondary"
                                    : "outline"
                              }
                            >
                              {statusLabel(plugin)}
                            </Badge>
                          </CardTitle>
                          <CardDescription className="break-all">
                            {plugin.packageName} · {plugin.version}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="flex min-w-0 flex-col gap-5">
                          {mode === "configuration" && (
                            <SlidingButtonGroup
                              value={detailTab}
                              options={["config", "functions", "matching"].map((value) => ({
                                value,
                                label: t(`pluginConfig.tabs.${value}`, { defaultValue: value }),
                              }))}
                              onChange={setDetailTab}
                            />
                          )}
                          {mode === "configuration" && (
                            <div hidden={detailTab !== "config"} className="min-w-0">
                              <PluginConfiguration
                                key={`${plugin.pluginId}@${plugin.version}`}
                                footerVisible={detailTab === "config"}
                                pluginId={plugin.pluginId}
                              />
                              {plugin.pluginId === "spark233.applications" && (
                                <ApplicationsDialog
                                  key={plugin.version}
                                  embedded
                                  open
                                  onOpenChange={() => {}}
                                />
                              )}
                            </div>
                          )}
                          {mode === "configuration" && detailTab === "matching" && (
                            <div className="flex flex-col gap-4">
                              {plugin.commands
                                .filter(
                                  (command) =>
                                    command.keywords?.length || command.sourceApplications?.length,
                                )
                                .map((command) => (
                                  <section key={command.id} className="flex flex-col gap-2">
                                    <h3 className="text-sm font-medium">{command.title}</h3>
                                    <p className="text-xs text-muted-foreground">
                                      {t("pluginConfig.declaredRules")}
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                      {command.keywords?.map((keyword) => (
                                        <Badge key={keyword} variant="secondary">
                                          {keyword}
                                        </Badge>
                                      ))}
                                      {command.sourceApplications?.map((application) => (
                                        <Badge key={application} variant="outline">
                                          {application}
                                        </Badge>
                                      ))}
                                    </div>
                                  </section>
                                ))}
                            </div>
                          )}
                          {mode === "configuration" && (
                            <div hidden={detailTab !== "functions"}>
                              {!!plugin.commands.length && (
                                <PluginShortcuts
                                  key={`${plugin.pluginId}@${plugin.version}`}
                                  plugin={plugin}
                                />
                              )}
                            </div>
                          )}
                          {mode === "configuration" && detailTab === "functions" && (
                            <div className="flex flex-wrap gap-2">
                              {plugin.commands
                                .filter((command) => command.launcher?.role !== "hidden")
                                .map((command) => (
                                  <Button
                                    key={command.id}
                                    variant="outline"
                                    disabled={
                                      !plugin.enabled ||
                                      !!plugin.lastError ||
                                      activating.includes(plugin.pluginId)
                                    }
                                    onClick={() => {
                                      void launch(plugin.pluginId, command.id);
                                    }}
                                  >
                                    {command.title}
                                  </Button>
                                ))}
                            </div>
                          )}
                          <div hidden={mode !== "market"} className="flex flex-col gap-3">
                            <details
                              className="min-w-0 text-sm"
                              onToggle={(event) => {
                                if (event.currentTarget.open && !notes && !notesLoading)
                                  void loadReleaseNotes(plugin);
                              }}
                            >
                              <summary className="cursor-pointer">
                                {t("plugins.releaseNotes.installed", { version: plugin.version })}
                              </summary>
                              {notesLoading ? (
                                <p role="status" className="mt-3 flex items-center gap-2">
                                  <Spinner />
                                  {t("plugins.releaseNotes.loading")}
                                </p>
                              ) : (
                                <>
                                  {renderReleaseNotes(notes)}
                                  {notes?.status === "error" && (
                                    <Button
                                      className="mt-2"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        void loadReleaseNotes(plugin);
                                      }}
                                    >
                                      {t("plugins.releaseNotes.retry")}
                                    </Button>
                                  )}
                                </>
                              )}
                            </details>
                            <p className="break-all text-xs text-muted-foreground">
                              {t("plugins.source", { defaultValue: "来源" })}:
                              {plugin.source.location}
                            </p>
                            {plugin.updateSource && (
                              <p className="break-all text-xs text-muted-foreground">
                                {t("plugins.updateSource")}:
                                {plugin.updateSource.kind === "utools"
                                  ? `uTools · ${plugin.updateSource.catalogId}`
                                  : `${plugin.updateSource.registry} · ${plugin.updateSource.channel}`}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                              {plugin.capabilities.map((capability) => (
                                <Badge key={capability} variant="outline">
                                  {t(`plugins.capability.${capability}`, {
                                    defaultValue: capabilityLabels[capability],
                                  })}
                                </Badge>
                              ))}
                            </div>
                            {(Object.keys(plugin.dependencies).length > 0 ||
                              Object.keys(plugin.optionalDependencies).length > 0) && (
                              <p className="text-xs text-muted-foreground">
                                {t("plugins.dependencies", { defaultValue: "必需依赖" })}:
                                {Object.entries(plugin.dependencies)
                                  .map(([id, range]) => `${id} ${range}`)
                                  .join(t("plugins.listSeparator", { defaultValue: "、" })) || "—"}
                                <br />
                                {t("plugins.optionalDependencies", { defaultValue: "可选依赖" })}:
                                {Object.entries(plugin.optionalDependencies)
                                  .map(([id, range]) => `${id} ${range}`)
                                  .join(t("plugins.listSeparator", { defaultValue: "、" })) || "—"}
                              </p>
                            )}
                            {plugin.lastError && (
                              <Alert variant="destructive">
                                <AlertDescription className="break-words">
                                  {plugin.lastError}
                                </AlertDescription>
                              </Alert>
                            )}
                            {update && (
                              <Alert>
                                <AlertTitle>
                                  {t("plugins.updateAvailable", { defaultValue: "有可用更新" })} ·{" "}
                                  {update.currentVersion} → {update.version}
                                </AlertTitle>
                                <AlertDescription>
                                  {t("plugins.updateHint", {
                                    defaultValue:
                                      "准备更新后，请核对新版本的来源和能力，再确认安装。",
                                  })}
                                </AlertDescription>
                              </Alert>
                            )}
                          </div>
                        </CardContent>
                        <CardFooter className="flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              void onNavigate({
                                page: mode === "configuration" ? "marketplace" : "plugins",
                                pluginId: plugin.pluginId,
                                tab: "config",
                              }).catch((value) => setError(errorText(value)));
                            }}
                          >
                            {mode === "configuration"
                              ? t("pluginMarket.managePlugin")
                              : t("pluginMarket.configurePlugin")}
                          </Button>
                          {mode === "market" && (
                            <>
                              <Button
                                size="sm"
                                disabled={
                                  disabled ||
                                  !plugin.enabled ||
                                  !!plugin.lastError ||
                                  activating.includes(plugin.pluginId) ||
                                  !plugin.commands.length
                                }
                                onClick={() => {
                                  void launch(plugin.pluginId);
                                }}
                              >
                                {t("plugins.open", { defaultValue: "打开" })}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={disabled}
                                onClick={() => {
                                  void run(
                                    t("plugins.switching", { defaultValue: "正在更改插件状态" }),
                                    () =>
                                      setPluginEnabled(
                                        plugin.pluginId,
                                        !!plugin.lastError || !plugin.enabled,
                                      ),
                                    t(
                                      !!plugin.lastError || !plugin.enabled
                                        ? "notifications.enabled"
                                        : "notifications.disabled",
                                      { name: plugin.displayName },
                                    ),
                                  );
                                }}
                              >
                                {plugin.lastError
                                  ? t("launcher.retry", { defaultValue: "重试" })
                                  : plugin.enabled
                                    ? t("plugins.disable", { defaultValue: "停用" })
                                    : t("plugins.enable", { defaultValue: "启用" })}
                              </Button>
                              {update && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    disabled || preparing.includes(`update:${plugin.pluginId}`)
                                  }
                                  onClick={() => {
                                    void prepare(`update:${plugin.pluginId}`, () =>
                                      preparePluginUpdate(plugin.pluginId),
                                    );
                                  }}
                                >
                                  {t("plugins.prepareUpdate", { defaultValue: "准备更新" })}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={disabled}
                                onClick={() => {
                                  setDeleteData(false);
                                  // An earlier failure must not read as this uninstall failing.
                                  setError(undefined);
                                  setRemoving(plugin);
                                }}
                              >
                                {t("plugins.uninstall", { defaultValue: "卸载" })}
                              </Button>
                            </>
                          )}
                        </CardFooter>
                      </Card>
                    );
                  })}
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <UninstallPluginDialog
        plugin={removing}
        busy={disabled}
        error={error}
        deleteData={deleteData}
        onDeleteDataChange={setDeleteData}
        onClose={() => setRemoving(undefined)}
        onConfirm={(plugin) =>
          void run(
            t("plugins.uninstalling", { defaultValue: "正在卸载插件" }),
            () => uninstallPlugin(plugin.pluginId, deleteData),
            t("notifications.uninstalled", { name: plugin.displayName }),
          ).then((ok) => {
            if (ok) setRemoving(undefined);
          })
        }
      />
    </>
  );
}
