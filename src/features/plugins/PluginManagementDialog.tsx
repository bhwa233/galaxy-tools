import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon, FolderOpenIcon, PackageIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
} from "@/components/ui/dialog";
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
import {
  activatePlugin,
  cancelPluginInstall,
  checkPluginUpdates,
  confirmPluginInstall,
  importPluginPackage,
  importPluginDirectory,
  listPlugins,
  preparePluginUpdate,
  prepareBundledPlugin,
  prepareRegistryPlugin,
  setPluginEnabled,
  uninstallPlugin,
  watchPluginsChanged,
} from "./api";
import type { PluginManagementState, PluginSummary } from "./types";

const capabilityLabels: Record<PluginSummary["capabilities"][number], string> = {
  storage: "插件私有存储",
  windows: "插件窗口",
  shortcuts: "全局快捷键",
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

export interface PluginManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Compose the installed registry primitives and existing desktop IPC boundary;
// state here is only form input and the host's authoritative management snapshot.
export function PluginManagementDialog({ open, onOpenChange }: PluginManagementDialogProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<PluginManagementState | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [activating, setActivating] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [registry, setRegistry] = useState("");
  const [channel, setChannel] = useState("");
  const [trust, setTrust] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<PluginSummary>();
  const [deleteData, setDeleteData] = useState(false);
  const active = useRef(false);
  const request = useRef(0);
  const operating = useRef(false);
  const commandTasks = useRef(new Set<string>());
  const errorText = (value: unknown) =>
    value instanceof Error
      ? value.message
      : value && typeof value === "object" && "message" in value
        ? String(value.message)
        : String(value);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const snapshot = await listPlugins();
      if (active.current && current === request.current) setState(snapshot);
    } catch (value) {
      if (active.current && current === request.current) setError(errorText(value));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    active.current = true;
    let unlisten: (() => void) | undefined;
    let closed = false;
    setError(undefined);
    void watchPluginsChanged(() => {
      void refresh();
    })
      .then((stop) => {
        if (closed) stop();
        else unlisten = stop;
      })
      .catch((value: unknown) => {
        if (!closed) setError(errorText(value));
      });
    void refresh();
    return () => {
      closed = true;
      active.current = false;
      request.current++;
      unlisten?.();
    };
  }, [open, refresh, i18n.resolvedLanguage]);

  const run = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (operating.current) return false;
    operating.current = true;
    setBusy(label);
    setError(undefined);
    try {
      await action();
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

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!removing) onOpenChange(value);
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
          <DialogHeader className="pr-7">
            <DialogTitle>{t("plugins.title", { defaultValue: "插件管理" })}</DialogTitle>
            <DialogDescription>
              {t("plugins.description", {
                defaultValue: "导入插件后确认安装；更新只提示，由你决定何时安装。",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-1 *:shrink-0">
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
            {(busy || activating.length > 0) && (
              <Alert aria-live="polite">
                <Spinner />
                <AlertTitle>
                  {busy || t("plugins.commandRunning", { defaultValue: "插件命令正在运行" })}
                </AlertTitle>
                <AlertDescription>
                  {busy
                    ? t("plugins.working", { defaultValue: "正在处理，请稍候。" })
                    : t("plugins.commandRunningHint", {
                        defaultValue: "你仍可以停用插件；宿主会先请求保存并取消任务。",
                      })}
                </AlertDescription>
              </Alert>
            )}

            {!!state?.catalog.length && (
              <Card size="sm">
                <CardHeader>
                  <CardTitle>{t("plugins.catalog.title")}</CardTitle>
                  <CardDescription>{t("plugins.catalog.description")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {state.catalog.map((item) => (
                    <div
                      key={item.pluginId}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
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
                        disabled={disabled || !item.canPrepare}
                        onClick={() => {
                          void run(t("plugins.catalog.preparing"), () =>
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

            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("plugins.add.title", { defaultValue: "添加插件" })}</CardTitle>
                <CardDescription>
                  {t("plugins.add.description", {
                    defaultValue:
                      "支持本地 .tgz、预构建开发目录和 npm 包。只有符合 spark233 清单的插件才能安装。",
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void run(
                        t("plugins.importing", { defaultValue: "正在导入插件包" }),
                        importPluginPackage,
                      );
                    }}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    {t("plugins.import", { defaultValue: "导入本地 .tgz" })}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void run(t("plugins.importingDirectory"), importPluginDirectory);
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
                    void run(t("plugins.preparing", { defaultValue: "正在准备安装预览" }), () =>
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
                          {t("plugins.channelHint", { defaultValue: "留空使用 latest 稳定通道。" })}
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
                  disabled={disabled || !name.trim()}
                >
                  {t("plugins.prepare", { defaultValue: "准备安装预览" })}
                </Button>
              </CardFooter>
            </Card>

            {!!state?.pending.length && (
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
                      </CardTitle>
                      <CardDescription className="break-all">
                        {preview.metadata.name} ·{" "}
                        {preview.source.kind === "directory"
                          ? t("plugins.directoryPackage")
                          : preview.source.kind === "file"
                            ? t("plugins.localPackage", { defaultValue: "本地包" })
                            : t("plugins.registryPackage", { defaultValue: "Registry 包" })}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <p className="break-all text-sm text-muted-foreground">
                        {t("plugins.source", { defaultValue: "来源" })}:{preview.source.location}
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
                          (preview.requiresNativeTrust && trust[preview.previewId] !== true)
                        }
                        onClick={() => {
                          void run(
                            t("plugins.installing", { defaultValue: "正在安装并验证插件" }),
                            () =>
                              confirmPluginInstall(
                                preview.previewId,
                                preview.requiresNativeTrust && trust[preview.previewId] === true,
                              ),
                          );
                        }}
                      >
                        {t("plugins.confirmInstall", { defaultValue: "确认安装" })}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
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

            <section
              className="flex flex-col gap-3"
              aria-label={t("plugins.installed", { defaultValue: "已安装插件" })}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  {t("plugins.installed", { defaultValue: "已安装插件" })}
                </h3>
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
              </div>
              {state?.lastChecked && (
                <p className="text-xs text-muted-foreground">
                  {t("plugins.lastChecked", { defaultValue: "上次检查" })}:
                  {new Date(state.lastChecked).toLocaleString(i18n.resolvedLanguage)}
                </p>
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
              {state?.plugins.map((plugin) => {
                const update = state.updates.find((item) => item.pluginId === plugin.pluginId);
                return (
                  <Card key={plugin.pluginId} size="sm">
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-2">
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
                    <CardContent className="flex flex-col gap-3">
                      <p className="break-all text-xs text-muted-foreground">
                        {t("plugins.source", { defaultValue: "来源" })}:{plugin.source.location}
                      </p>
                      {plugin.updateSource && (
                        <p className="break-all text-xs text-muted-foreground">
                          {t("plugins.updateSource")}:{plugin.updateSource.registry} ·{" "}
                          {plugin.updateSource.channel}
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
                              defaultValue: "准备更新后，请核对新版本的来源和能力，再确认安装。",
                            })}
                          </AlertDescription>
                        </Alert>
                      )}
                      {!!plugin.commands.length && (
                        <div
                          className="flex flex-wrap gap-2"
                          aria-label={t("plugins.commands", { defaultValue: "可用命令" })}
                        >
                          {plugin.commands.map((command) => (
                            <Button
                              key={command.id}
                              variant="outline"
                              size="sm"
                              disabled={
                                disabled ||
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
                    </CardContent>
                    <CardFooter className="flex-wrap gap-2">
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
                            () => setPluginEnabled(plugin.pluginId, !plugin.enabled),
                          );
                        }}
                      >
                        {plugin.enabled
                          ? t("plugins.disable", { defaultValue: "停用" })
                          : t("plugins.enable", { defaultValue: "启用" })}
                      </Button>
                      {update && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => {
                            void run(
                              t("plugins.preparingUpdate", { defaultValue: "正在准备更新预览" }),
                              () => preparePluginUpdate(plugin.pluginId),
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
                          setRemoving(plugin);
                        }}
                      >
                        {t("plugins.uninstall", { defaultValue: "卸载" })}
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!removing}
        onOpenChange={(value) => {
          if (!value && !disabled) setRemoving(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("plugins.uninstallTitle", { defaultValue: "卸载插件" })} · {removing?.displayName}
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
            <Field orientation="horizontal" data-disabled={disabled}>
              <Checkbox
                id="plugin-delete-data"
                checked={deleteData}
                onCheckedChange={(checked) => setDeleteData(checked === true)}
                disabled={disabled}
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
            <AlertDialogCancel disabled={disabled}>
              {t("plugins.keep", { defaultValue: "取消" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={disabled || !removing}
              onClick={(event) => {
                event.preventDefault();
                if (removing)
                  void run(t("plugins.uninstalling", { defaultValue: "正在卸载插件" }), () =>
                    uninstallPlugin(removing.pluginId, deleteData),
                  ).then((ok) => {
                    if (ok) setRemoving(undefined);
                  });
              }}
            >
              {disabled && <Spinner data-icon="inline-start" />}
              {t("plugins.confirmUninstall", { defaultValue: "确认卸载" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
