import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreHorizontalIcon,
  PackageIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { OcrWorkspace } from "../ocr/OcrWorkspace";
import { TranslationWorkspace } from "../translation/TranslationWorkspace";
import { SettingsPanel } from "../../components/SettingsPanel";
import { getCurrentWindow, invoke, listen } from "../../platform/desktop";
import { ClipboardPanel } from "./ClipboardPanel";
import { registerHostPreparation, prepareHostWindow } from "../windows/hostPreparation";
import { BackupDialog } from "../backup/BackupDialog";
import { SearchScopeDialog } from "../search/SearchScopeDialog";
import { SearchPreviewDialog, type SearchPreview } from "../search/SearchPreviewDialog";
import { PluginManagementDialog } from "../plugins/PluginManagementDialog";
import { chooseDataDirectory, getConfig, migrateDataDir, saveConfig } from "../settings/api";
import type { AppConfig } from "../settings/types";
import {
  completeLauncherOnboarding,
  executeLauncherItem,
  executeLauncherAction,
  getLauncherState,
  hideLauncher,
  pickLauncherDirectory,
  queryLauncher,
  recordLauncherMode,
} from "./api";
import type {
  LauncherCommand,
  LauncherItem,
  LauncherItemAction,
  LauncherQueryResult,
  LauncherState,
} from "./types";

function message(value: unknown): string {
  return value instanceof Error
    ? value.message
    : value && typeof value === "object" && "message" in value
      ? String(value.message)
      : String(value);
}
const itemKey = (item: LauncherItem) => JSON.stringify([item.pluginId, item.id]);

/** Host-side search is authoritative; cmdk supplies selection and keyboard
 * navigation. The frontend owns only input, mode and request-session state. */
export function Launcher() {
  const { t, i18n } = useTranslation();
  const { t: searchText } = useTranslation("search");
  const [state, setState] = useState<LauncherState>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<{ key: string; title: string }>();
  const [directory, setDirectory] = useState<string>();
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeRevision, setScopeRevision] = useState(0);
  const [result, setResult] = useState<LauncherQueryResult>();
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string>();
  const [stateError, setStateError] = useState<string>();
  const [queryError, setQueryError] = useState<string>();
  const displayError = error ?? stateError ?? queryError;
  const [actionItem, setActionItem] = useState<LauncherItem>();
  const [preview, setPreview] = useState<SearchPreview>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const routeParams = new URLSearchParams(window.location.search);
  const compactWorkspace = routeParams.get("compact") === "1";
  const separateWorkspace = routeParams.has("workspace");
  const [workspace, setWorkspace] = useState<{ kind: string; result: unknown } | undefined>(() =>
    ["clipboard", "translation"].includes(routeParams.get("workspace") ?? "")
      ? { kind: routeParams.get("workspace")!, result: undefined }
      : undefined,
  );
  const acceptResult = (value: unknown) => {
    if (value && typeof value === "object" && "searchPreview" in value) {
      setPreview(value.searchPreview as SearchPreview);
      setPreviewOpen(true);
      return;
    }
    if (value && typeof value === "object" && "launcherResults" in value) {
      const next = value.launcherResults as LauncherQueryResult;
      setResult((previous) =>
        "append" in value && value.append && previous
          ? { ...next, items: [...previous.items, ...next.items] }
          : next,
      );
      return;
    }
    if (value && typeof value === "object" && "workspace" in value && "result" in value)
      setWorkspace({ kind: String(value.workspace), result: value.result });
  };
  const [executing, setExecuting] = useState<string[]>([]);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig>();
  const [settingsError, setSettingsError] = useState<string>();
  const [savingSettings, setSavingSettings] = useState(false);
  const [migrationTarget, setMigrationTarget] = useState<string>();
  const [migrating, setMigrating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const composition = useRef(false);
  const compositionEnded = useRef(0);
  const queryGeneration = useRef(0);
  const stateGeneration = useRef(0);
  const settingsGeneration = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(
    () =>
      registerHostPreparation(async () => {
        await writes.current;
      }),
    [],
  );
  const tasks = useRef(new Set<string>());
  const finishingOnboarding = useRef(false);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  const refreshState = useCallback(async () => {
    const generation = ++stateGeneration.current;
    try {
      const next = await getLauncherState();
      if (mounted.current && generation === stateGeneration.current) {
        setState(next);
        setStateError(undefined);
      }
    } catch (value) {
      if (mounted.current && generation === stateGeneration.current) setStateError(message(value));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refreshState();
    focusInput();
    const subscriptions = [
      listen("plugins-changed", () => {
        void refreshState();
      }),
      listen("launcher-status-changed", () => {
        void refreshState();
      }),
      listen("search-scope-changed", () => {
        queryGeneration.current++;
        setResult(undefined);
        setSelected("");
        setScopeRevision((value) => value + 1);
      }),
      listen("launcher-shown", () => {
        void refreshState();
        focusInput();
      }),
      listen("ocr-result", (event) => setWorkspace({ kind: "ocr", result: event.payload })),
      listen<{ kind: string; result?: unknown }>("open-workspace", (event) => {
        void invoke<{ kind: string; result?: unknown } | undefined>("launcher_take_workspace")
          .then((value) =>
            setWorkspace({
              kind: value?.kind ?? event.payload.kind,
              result: value?.result ?? event.payload.result,
            }),
          )
          .catch((value) => setError(message(value)));
      }),
    ];
    void invoke<{ kind: string; result?: unknown } | undefined>("launcher_take_workspace")
      .then((value) => {
        if (value && mounted.current) setWorkspace({ kind: value.kind, result: value.result });
      })
      .catch((value) => {
        if (mounted.current) setError(message(value));
      });
    const drop = separateWorkspace
      ? Promise.resolve(() => {})
      : getCurrentWindow().onDragDropEvent((event) => {
          void invoke<LauncherState>("launcher_context_files", { paths: event.payload.paths })
            .then((next) => {
              setWorkspace(undefined);
              setState(next);
              focusInput();
            })
            .catch((value) => setError(message(value)));
        });
    for (const subscription of subscriptions)
      void subscription.catch((value: unknown) => {
        if (mounted.current) setError(message(value));
      });
    return () => {
      mounted.current = false;
      queryGeneration.current++;
      stateGeneration.current++;
      for (const subscription of subscriptions)
        void subscription.then((stop) => stop()).catch(() => {});
      void drop.then((stop) => stop()).catch(() => {});
    };
  }, [focusInput, refreshState, i18n.resolvedLanguage]);

  useEffect(() => {
    const generation = ++queryGeneration.current;
    setResult(undefined);
    setSelected("");
    if (!state || composing || workspace || scopeOpen) {
      setLoading(false);
      if (workspace) setQueryError(undefined);
      return;
    }
    const sessionId = crypto.randomUUID();
    setLoading(true);
    // A short input delay avoids dispatching every keystroke to native sources;
    // request generations and returned session IDs isolate all late results.
    const timer = setTimeout(
      () => {
        void queryLauncher(query, sessionId, mode?.key, directory)
          .then((next) => {
            if (
              !mounted.current ||
              generation !== queryGeneration.current ||
              next.sessionId !== sessionId
            )
              return;
            setResult(next);
            setQueryError(undefined);
            setSelected(next.items[0] ? itemKey(next.items[0]) : "");
            setLoading(false);
          })
          .catch((value: unknown) => {
            if (mounted.current && generation === queryGeneration.current) {
              setQueryError(message(value));
              setResult(undefined);
              setLoading(false);
            }
          });
      },
      query ? 100 : 0,
    );
    return () => {
      clearTimeout(timer);
      queryGeneration.current++;
    };
  }, [query, mode?.key, directory, scopeRevision, state, composing, workspace, scopeOpen]);

  const returnFromMode = () => {
    queryGeneration.current++;
    setMode(undefined);
    setDirectory(undefined);
    setQuery("");
    setResult(undefined);
    setSelected("");
    setError(undefined);
    setQueryError(undefined);
    focusInput();
  };
  const closeWorkspace = async () => {
    await prepareHostWindow();
    if (separateWorkspace) {
      if (compactWorkspace) await getCurrentWindow().close();
      else await invoke("launcher_return");
    } else {
      setWorkspace(undefined);
      focusInput();
    }
  };
  const escape = () => {
    if (workspace || separateWorkspace) {
      void closeWorkspace().catch((value) => setError(message(value)));
    } else if (mode) returnFromMode();
    else if (query) {
      setQuery("");
      setError(undefined);
      setQueryError(undefined);
      focusInput();
    } else void hideLauncher().catch((value: unknown) => setError(message(value)));
  };
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        composition.current ||
        settingsOpen ||
        pluginsOpen ||
        backupOpen ||
        scopeOpen ||
        actionItem ||
        previewOpen ||
        migrationTarget
      )
        return;
      event.preventDefault();
      escape();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  });
  const findCommand = (item: LauncherItem) =>
    state?.commands.find(
      (command) => command.pluginId === item.pluginId && command.id === (item.commandId ?? item.id),
    );
  const enterMode = (command: LauncherCommand, remainder = "") => {
    if (!command.mode || !command.enabled) return;
    void recordLauncherMode(command.mode).catch((value) => setError(message(value)));
    queryGeneration.current++;
    setMode({ key: command.mode, title: command.title });
    setDirectory(undefined);
    setQuery(remainder);
    setResult(undefined);
    setSelected("");
    setError(undefined);
    setQueryError(undefined);
    focusInput();
  };
  const selectItem = async (item: LauncherItem) => {
    if (composition.current || !state?.pluginsReady || settingsOpen || pluginsOpen) return;
    const command = findCommand(item);
    if (command && !command.enabled) return;
    if (!mode && command?.mode) {
      enterMode(command);
      return;
    }
    const key = itemKey(item);
    if (tasks.current.has(key)) return;
    tasks.current.add(key);
    setExecuting([...tasks.current]);
    setError(undefined);
    try {
      acceptResult(await executeLauncherItem(item));
    } catch (value) {
      if (mounted.current) setError(message(value));
    } finally {
      tasks.current.delete(key);
      if (mounted.current) setExecuting([...tasks.current]);
    }
  };
  const selectAction = async (item: LauncherItem, action: LauncherItemAction) => {
    if (!state?.pluginsReady || composition.current) return;
    const key = JSON.stringify([item.pluginId, action.id]);
    if (tasks.current.has(key)) return;
    tasks.current.add(key);
    setExecuting([...tasks.current]);
    setActionItem(undefined);
    setError(undefined);
    try {
      acceptResult(await executeLauncherAction(item, action));
    } catch (value) {
      if (mounted.current) setError(message(value));
    } finally {
      tasks.current.delete(key);
      if (mounted.current) setExecuting([...tasks.current]);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const isComposition =
      composition.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (
      isComposition ||
      (event.key === "Enter" && performance.now() - compositionEnded.current < 50)
    ) {
      // Let the native IME consume these keys, without cmdk executing a command.
      event.stopPropagation();
      return;
    }
    if ((event.key === "F10" && event.shiftKey) || (event.key === "Enter" && event.altKey)) {
      const item = result?.items.find((item) => itemKey(item) === selected);
      if (item?.actions?.length) {
        event.preventDefault();
        event.stopPropagation();
        setActionItem(item);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      escape();
      return;
    }
    if (event.key === "Backspace" && !query && mode && event.target === input.current) {
      event.preventDefault();
      event.stopPropagation();
      returnFromMode();
      return;
    }
    if (
      event.key === "Tab" &&
      event.target === input.current &&
      !event.shiftKey &&
      !mode &&
      query.trim()
    ) {
      const [keyword, ...rest] = query.trim().split(/\s+/);
      const matches = state?.commands.filter(
        (command) =>
          command.enabled &&
          command.mode &&
          command.keywords.some((word) => word.toLocaleLowerCase() === keyword.toLocaleLowerCase()),
      );
      if (matches?.length === 1) {
        event.preventDefault();
        event.stopPropagation();
        enterMode(matches[0], rest.join(" "));
      }
    }
  };
  const finishOnboarding = async () => {
    if (finishingOnboarding.current) return;
    finishingOnboarding.current = true;
    setOnboardingBusy(true);
    setError(undefined);
    try {
      await completeLauncherOnboarding();
      await refreshState();
      focusInput();
    } catch (value) {
      setError(message(value));
    } finally {
      finishingOnboarding.current = false;
      setOnboardingBusy(false);
    }
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    setSettingsError(undefined);
    try {
      setConfig(await getConfig());
    } catch (value) {
      setSettingsError(message(value));
    }
  };
  const changeSettings = (next: AppConfig) => {
    const generation = ++settingsGeneration.current;
    setConfig(next);
    setSavingSettings(true);
    setSettingsError(undefined);
    const operation = writes.current.catch(() => {}).then(() => saveConfig(next));
    writes.current = operation;
    void operation
      .then((saved) => {
        if (mounted.current && generation === settingsGeneration.current) setConfig(saved);
      })
      .catch((value: unknown) => {
        if (mounted.current) setSettingsError(message(value));
      })
      .finally(() => {
        if (mounted.current && generation === settingsGeneration.current) setSavingSettings(false);
      });
  };
  const chooseMigration = async () => {
    setSettingsError(undefined);
    try {
      const destination = await chooseDataDirectory();
      if (destination) setMigrationTarget(destination);
    } catch (value) {
      setSettingsError(message(value));
    }
  };
  const migrate = async () => {
    if (!migrationTarget || migrating) return;
    setMigrating(true);
    setSettingsError(undefined);
    try {
      await writes.current;
      setConfig(await migrateDataDir(migrationTarget));
      setMigrationTarget(undefined);
    } catch (value) {
      setSettingsError(message(value));
    } finally {
      setMigrating(false);
    }
  };

  const modeTitle = mode
    ? (state?.commands.find((command) => command.mode === mode.key)?.title ?? mode.title)
    : undefined;
  const modeOptions = mode ? state?.modeOptions?.[mode.key] : undefined;
  const close = () => {
    void closeWorkspace().catch((value) => setError(message(value)));
  };
  const workspaceFrame = (content: ReactNode) => (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="electron-title-drag flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <span>spark233</span>
        <Button size="sm" variant="ghost" onClick={close}>
          {t("common.back")}
        </Button>
      </header>
      {displayError && (
        <Alert variant="destructive">
          <AlertDescription>{displayError}</AlertDescription>
        </Alert>
      )}
      {content}
    </main>
  );
  const availableCommands = new Set(
    state?.commands
      .filter((command) => command.enabled)
      .map((command) => `${command.pluginId}:${command.id}`),
  );
  const availableTextTargets = {
    notes: availableCommands.has("spark233.notes:new"),
    dictionary: availableCommands.has("spark233.translation:search"),
    ai: availableCommands.has("spark233.translation:translate"),
  };
  const unavailableTargetReason = t("plugins.actionUnavailable");
  if (workspace?.kind === "ocr")
    return workspaceFrame(
      <OcrWorkspace
        initialResult={workspace.result}
        onClose={close}
        onResult={acceptResult}
        availableTargets={{
          notes: availableTextTargets.notes,
          dictionary: availableTextTargets.dictionary,
          translate: availableTextTargets.ai,
        }}
        unavailableTargetReason={unavailableTargetReason}
      />,
    );
  if (workspace?.kind === "translation")
    return workspaceFrame(
      <TranslationWorkspace
        initialResult={workspace.result}
        onClose={close}
        notesAvailable={availableTextTargets.notes}
        unavailableTargetReason={unavailableTargetReason}
      />,
    );
  if (workspace?.kind === "clipboard")
    return workspaceFrame(
      <ClipboardPanel
        compact={compactWorkspace}
        onClose={close}
        onResult={acceptResult}
        availableTextTargets={availableTextTargets}
        imageOcrAvailable={availableCommands.has("spark233.ocr:ocr")}
        unavailableTargetReason={unavailableTargetReason}
      />,
    );
  if (separateWorkspace)
    return workspaceFrame(
      <div className="flex items-center justify-center p-6">
        <Spinner />
      </div>,
    );
  return (
    <main className="flex h-screen flex-col gap-3 overflow-hidden bg-background p-4 text-foreground">
      <header className="electron-title-drag flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">spark233</h1>
          {mode && <Badge variant="secondary">{modeTitle}</Badge>}
          {state?.contextLabel && <Badge variant="outline">{state.contextLabel}</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setBackupOpen(true)}>
            {t("launcher.backup", { defaultValue: "备份" })}
          </Button>
          {state?.contextLabel && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void invoke<LauncherState>("launcher_context_clear")
                  .then(setState)
                  .catch((value) => setError(message(value)));
              }}
            >
              {t("launcher.clearContext", { defaultValue: "清除内容" })}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPluginsOpen(true)}>
            <PackageIcon data-icon="inline-start" />
            {t("launcher.plugins", { defaultValue: "插件" })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void openSettings();
            }}
          >
            <SettingsIcon data-icon="inline-start" />
            {t("launcher.settings", { defaultValue: "设置" })}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("launcher.hide", { defaultValue: "隐藏启动器" })}
            onClick={() => {
              void hideLauncher().catch((value: unknown) => setError(message(value)));
            }}
          >
            <XIcon />
          </Button>
        </div>
      </header>

      {state?.firstRun && (
        <Card size="sm" className="shrink-0">
          <CardHeader>
            <CardTitle>
              {t("launcher.welcome.title", { defaultValue: "欢迎使用 spark233" })}
            </CardTitle>
            <CardDescription>
              {t("launcher.welcome.description", {
                defaultValue: "从这里呼出命令、进入插件模式。便签、搜索和其他能力由各自插件提供。",
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t("launcher.welcome.keys", {
                defaultValue:
                  "输入关键词查找入口，↑ ↓ 选择，Enter 执行；选中模式后继续输入，Esc 返回。插件可在管理页独立启停。",
              })}
            </p>
          </CardContent>
          <CardFooter>
            <Button
              size="sm"
              disabled={onboardingBusy}
              onClick={() => {
                void finishOnboarding();
              }}
            >
              {onboardingBusy && <Spinner data-icon="inline-start" />}
              {t("launcher.welcome.complete", { defaultValue: "完成引导，开始使用" })}
            </Button>
          </CardFooter>
        </Card>
      )}
      {displayError && (
        <Alert variant="destructive" className="shrink-0">
          <AlertTitle>{t("launcher.error", { defaultValue: "暂时无法完成操作" })}</AlertTitle>
          <AlertDescription className="break-words">{displayError}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(undefined);
              void refreshState();
            }}
          >
            {t("launcher.retry", { defaultValue: "重试" })}
          </Button>
        </Alert>
      )}
      {state?.warnings?.map((warning) => (
        <Alert key={warning} className="shrink-0">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}
      {state && !state.pluginsReady && (
        <Alert className="shrink-0">
          <Spinner />
          <AlertTitle>{t("launcher.starting", { defaultValue: "插件正在准备中" })}</AlertTitle>
          <AlertDescription>
            {t("launcher.startingHint", {
              defaultValue: "准备完成后可执行命令，也可以先检查插件状态。",
            })}
          </AlertDescription>
        </Alert>
      )}

      <Command
        label={t("launcher.searchLabel", { defaultValue: "搜索命令与插件" })}
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDownCapture={onKeyDown}
        className="min-h-0 flex-1"
      >
        {mode && (
          <div
            className="flex flex-wrap items-center gap-2 p-1"
            onKeyDown={(event) => {
              // Toolbar buttons keep their native activation; cmdk must not
              // execute the selected result when a button receives Enter.
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          >
            <Button size="sm" variant="ghost" onClick={returnFromMode}>
              <ArrowLeftIcon data-icon="inline-start" />
              {t("launcher.back", { defaultValue: "返回全部入口" })}
            </Button>
            <Badge variant="outline">{modeTitle}</Badge>
            {modeOptions?.directoryFilter && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="max-w-full truncate"
                  title={directory}
                  onClick={() => {
                    void pickLauncherDirectory()
                      .then((value) => {
                        if (value) setDirectory(value);
                        focusInput();
                      })
                      .catch((value) => setError(message(value)));
                  }}
                >
                  {directory ?? searchText("chooseDirectory")}
                </Button>
                {directory && (
                  <Button size="sm" variant="ghost" onClick={() => setDirectory(undefined)}>
                    {searchText("allDirectories")}
                  </Button>
                )}
              </>
            )}
            {mode.key.startsWith("spark233.search:") && (
              <Button size="sm" variant="ghost" onClick={() => setScopeOpen(true)}>
                {searchText("title")}
              </Button>
            )}
          </div>
        )}
        <CommandInput
          ref={input}
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setError(undefined);
            setQueryError(undefined);
          }}
          autoFocus
          aria-label={
            mode
              ? `${modeTitle} ${t("launcher.input", { defaultValue: "查询" })}`
              : t("launcher.searchLabel", { defaultValue: "搜索命令与插件" })
          }
          placeholder={
            mode
              ? (modeOptions?.placeholder ??
                t("launcher.modePlaceholder", {
                  title: modeTitle,
                  defaultValue: "在 {{title}} 中搜索…",
                }))
              : t("launcher.placeholder", { defaultValue: "输入应用、命令或插件关键词…" })
          }
          onCompositionStart={() => {
            composition.current = true;
            setComposing(true);
          }}
          onCompositionEnd={(event) => {
            composition.current = false;
            compositionEnded.current = performance.now();
            setQuery(event.currentTarget.value);
            setComposing(false);
          }}
        />
        <CommandList className="max-h-none min-h-0 flex-1" aria-busy={loading}>
          {loading && (
            <div
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner />
              {t("launcher.searching", { defaultValue: "正在查询…" })}
            </div>
          )}
          {!loading && !composing && (
            <CommandEmpty>
              {t("launcher.empty", {
                defaultValue: "没有匹配的入口，试试其他关键词或检查插件是否启用。",
              })}
            </CommandEmpty>
          )}
          <CommandGroup
            heading={modeTitle ?? t("launcher.results", { defaultValue: "入口与本地结果" })}
          >
            {result?.items.map((item) => {
              const command = findCommand(item);
              const key = itemKey(item);
              const isMode = !mode && !!command?.mode;
              return (
                <CommandItem
                  key={key}
                  value={key}
                  disabled={
                    !state?.pluginsReady || command?.enabled === false || executing.includes(key)
                  }
                  onSelect={() => {
                    void selectItem(item);
                  }}
                >
                  {item.icon && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(item.icon) && (
                    <img
                      src={item.icon}
                      alt=""
                      className="size-7 shrink-0 object-contain"
                      width={28}
                      height={28}
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 truncate">
                      {item.title}
                      {item.usage && (
                        <Badge variant="outline">
                          {item.usage.count > 1
                            ? t("launcher.frequentlyUsed")
                            : t("launcher.recentlyUsed")}
                        </Badge>
                      )}
                    </span>
                    {item.description && (
                      <span className="truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </div>
                  {!!item.actions?.length && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("launcher.resultActions", {
                        title: item.title,
                        defaultValue: i18n.resolvedLanguage?.startsWith("en")
                          ? "Actions for {{title}}"
                          : "{{title}}的操作",
                      })}
                      title="Alt+Enter / Shift+F10"
                      aria-keyshortcuts="Alt+Enter Shift+F10"
                      onClick={(event) => {
                        event.stopPropagation();
                        setActionItem(item);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                      }}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  )}
                  {executing.includes(key) ? (
                    <Spinner />
                  ) : isMode ? (
                    <CommandShortcut>
                      <ArrowRightIcon
                        aria-label={t("launcher.enterMode", { defaultValue: "进入模式" })}
                      />
                    </CommandShortcut>
                  ) : (
                    <CommandShortcut>↵</CommandShortcut>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status">
          {result?.hint ??
            t("launcher.navigation", { defaultValue: "↑ ↓ 选择 · Enter 执行 · Esc 返回或隐藏" })}
        </span>
        {!mode && <span>{t("launcher.modeHint", { defaultValue: "关键词 + Tab 进入模式" })}</span>}
      </footer>

      <SearchScopeDialog
        open={scopeOpen}
        onOpenChange={(value) => {
          setScopeOpen(value);
          if (!value) focusInput();
        }}
      />
      <Dialog
        open={!!actionItem}
        onOpenChange={(open) => {
          if (!open) {
            setActionItem(undefined);
            focusInput();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionItem?.title}</DialogTitle>
            <DialogDescription>
              {t("launcher.chooseAction", {
                defaultValue: i18n.resolvedLanguage?.startsWith("en")
                  ? "Choose an action for this result."
                  : "选择此结果的操作。",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {actionItem?.actions?.map((action) => (
              <Button
                key={action.id}
                variant="outline"
                className="justify-start"
                disabled={
                  !state?.pluginsReady ||
                  executing.includes(JSON.stringify([actionItem.pluginId, action.id]))
                }
                onClick={() => void selectAction(actionItem, action)}
              >
                {action.title}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <SearchPreviewDialog
        value={preview}
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) focusInput();
        }}
      />
      <PluginManagementDialog
        open={pluginsOpen}
        onOpenChange={(value) => {
          setPluginsOpen(value);
          if (!value) {
            void refreshState();
            focusInput();
          }
        }}
      />
      <Dialog
        open={settingsOpen}
        onOpenChange={(value) => {
          if (!migrationTarget) {
            setSettingsOpen(value);
            if (!value) focusInput();
          }
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden p-0 sm:max-w-[360px]">
          <DialogHeader className="sr-only">
            <DialogTitle>{t("launcher.settings", { defaultValue: "设置" })}</DialogTitle>
            <DialogDescription>
              {t("launcher.settingsDescription", { defaultValue: "修改应用设置并保存到宿主。" })}
            </DialogDescription>
          </DialogHeader>
          {settingsError && (
            <Alert variant="destructive">
              <AlertDescription>{settingsError}</AlertDescription>
            </Alert>
          )}
          {savingSettings && (
            <div className="flex items-center gap-2 px-4 py-2 text-sm" role="status">
              <Spinner />
              {t("launcher.savingSettings", { defaultValue: "正在保存设置" })}
            </div>
          )}
          <div className="h-[min(72vh,680px)] overflow-hidden">
            {config ? (
              <SettingsPanel
                config={config}
                onChange={changeSettings}
                onMigrateDataDir={() => {
                  void chooseMigration();
                }}
                onClose={() => {
                  setSettingsOpen(false);
                  focusInput();
                }}
              />
            ) : (
              <div className="flex items-center gap-2 p-4">
                <Spinner />
                {t("launcher.loadingSettings", { defaultValue: "正在读取设置" })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!migrationTarget}
        onOpenChange={(value) => {
          if (!value && !migrating) setMigrationTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("launcher.migrate.title", { defaultValue: "迁移数据目录" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("launcher.migrate.description", {
                defaultValue: "确认将现有便签数据迁移到所选位置。迁移期间请等待完成。",
              })}
              <span className="mt-2 block break-all">{migrationTarget}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {settingsError && (
            <Alert variant="destructive">
              <AlertDescription>{settingsError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrating}>
              {t("launcher.cancel", { defaultValue: "取消" })}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={migrating || savingSettings}
              onClick={(event) => {
                event.preventDefault();
                void migrate();
              }}
            >
              {migrating && <Spinner data-icon="inline-start" />}
              {t("launcher.migrate.confirm", { defaultValue: "确认迁移" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <BackupDialog open={backupOpen} onOpenChange={setBackupOpen} />
    </main>
  );
}

export default Launcher;
