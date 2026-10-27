import { PluginIcon, pluginEntryCommands } from "../plugins/PluginIcon";
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
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreHorizontalIcon,
  PinIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { OcrWorkspace } from "../ocr/OcrWorkspace";
import { TranslationWorkspace } from "../translation/TranslationWorkspace";
import { getCurrentWindow, invoke, listen } from "../../platform/desktop";
import { ClipboardPanel } from "./ClipboardPanel";
import { prepareHostWindow } from "../windows/hostPreparation";
import { SearchPreviewDialog, type SearchPreview } from "../search/SearchPreviewDialog";
import {
  closeContextPanel,
  getContextPanelState,
  returnFromContextPanel,
  watchContextPanelState,
} from "../context-panel/api";
import type { ContextPanelViewState } from "../context-panel/types";
import { openSettingsWindow } from "../settings/api";
import {
  cancelLauncherQuery,
  completeLauncherOnboarding,
  executeLauncherItem,
  executeLauncherAction,
  getLauncherState,
  hideLauncher,
  pickLauncherDirectory,
  queryLauncher,
  recordLauncherMode,
  updateLauncherPreference,
} from "./api";
import type {
  LauncherCommand,
  LauncherItem,
  LauncherItemAction,
  LauncherPreferenceMutation,
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

// Installed application backends append static search instructions to their
// diagnostics. Hide that boilerplate while retaining actual source warnings.
function applicationStatus(hint?: string): string | undefined {
  return hint
    ?.replace(
      /\s*(?:支持应用原名、中文全拼、拼音首字母与中英混排。|Search original names, full pinyin, initials, or mixed Chinese and Latin text\.)\s*$/,
      "",
    )
    .trim();
}

/** Host-side search is authoritative; cmdk supplies selection and keyboard
 * navigation. The frontend owns only input, mode and request-session state. */
export function Launcher() {
  const { t, i18n } = useTranslation();
  const { t: searchText } = useTranslation("search");
  const isContextPanel = getCurrentWindow().label === "context-panel";
  const [panelView, setPanelView] = useState<ContextPanelViewState>();
  const panelRevision = useRef(-1);
  const panelEvents = useRef(0);
  const [panelBusy, setPanelBusy] = useState(false);
  const panelOperation = useRef<{ sessionId?: string; revision: number } | undefined>(undefined);
  const [panelReadFailed, setPanelReadFailed] = useState(false);
  const [state, setState] = useState<LauncherState>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<{ key: string; title: string }>();
  const [directory, setDirectory] = useState<string>();
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
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string>();
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
          ? {
              ...next,
              items: [
                ...previous.items.filter(
                  (item) =>
                    !(
                      item.commandId === "next-page" &&
                      "pagePluginId" in value &&
                      item.pluginId === value.pagePluginId
                    ),
                ),
                ...next.items,
              ],
            }
          : next,
      );
      return;
    }
    if (value && typeof value === "object" && "workspace" in value && "result" in value)
      setWorkspace({ kind: String(value.workspace), result: value.result });
  };
  const [executing, setExecuting] = useState<string[]>([]);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const composition = useRef(false);
  const compositionEnded = useRef(0);
  const queryGeneration = useRef(0);
  const stateGeneration = useRef(0);
  const stateSnapshot = useRef<LauncherState | undefined>(undefined);
  const stateRequest = useRef<number | undefined>(undefined);
  const tasks = useRef(new Set<string>());
  const finishingOnboarding = useRef(false);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  const acceptPanelView = useCallback(
    (next: ContextPanelViewState) => {
      if (next.revision <= panelRevision.current) return;
      panelRevision.current = next.revision;
      panelOperation.current = undefined;
      setPanelBusy(false);
      queryGeneration.current++;
      setPanelView(next);
      setPanelReadFailed(false);
      setQuery(next.suggestedQuery ?? "");
      setMode(undefined);
      setDirectory(undefined);
      setWorkspace(undefined);
      setActionItem(undefined);
      setPreviewOpen(false);
      setResult(undefined);
      setSelected("");
      setError(undefined);
      setQueryError(undefined);
      focusInput();
    },
    [focusInput],
  );
  const refreshState = useCallback(async () => {
    const generation = ++stateGeneration.current;
    stateRequest.current = generation;
    try {
      const next = await getLauncherState();
      if (mounted.current && generation === stateGeneration.current) {
        stateSnapshot.current = next;
        setState(next);
        setStateError(undefined);
      }
    } catch (value) {
      if (mounted.current && generation === stateGeneration.current) setStateError(message(value));
    } finally {
      if (stateRequest.current === generation) stateRequest.current = undefined;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refreshState();
    focusInput();
    const subscriptions = [
      listen<NonNullable<LauncherState["learning"]>>("launcher-learning-changed", ({ payload }) => {
        // Automatic learning is metadata only: never invalidate an executing
        // result or restart its query just because the record count changed.
        const replacePendingSnapshot = stateRequest.current !== undefined;
        stateGeneration.current++;
        if (stateSnapshot.current) {
          const next = { ...stateSnapshot.current, learning: payload };
          stateSnapshot.current = next;
          setState(next);
        }
        // Replace a now-stale full read, including the initial bootstrap, so a
        // concurrent catalog/toggle/clear notification cannot be lost.
        if (!stateSnapshot.current || replacePendingSnapshot) void refreshState();
      }),
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
        setScopeRevision((value) => value + 1);
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
    const drop =
      separateWorkspace || isContextPanel
        ? Promise.resolve(() => {})
        : getCurrentWindow().onDragDropEvent((event) => {
            const generation = ++stateGeneration.current;
            void invoke<LauncherState>("launcher_context_files", { paths: event.payload.paths })
              .then((next) => {
                if (!mounted.current || generation !== stateGeneration.current) return;
                setWorkspace(undefined);
                stateSnapshot.current = next;
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
  }, [focusInput, refreshState, i18n.resolvedLanguage, isContextPanel]);

  useEffect(() => {
    if (!isContextPanel) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void watchContextPanelState((next) => {
      if (disposed) return;
      panelEvents.current++;
      acceptPanelView(next);
    })
      .then(async (unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
        const revision = panelEvents.current;
        const next = await getContextPanelState();
        if (disposed || revision !== panelEvents.current) return;
        if (next) acceptPanelView(next);
        else setPanelReadFailed(true);
      })
      .catch(() => {
        if (!disposed) setPanelReadFailed(true);
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [isContextPanel, acceptPanelView]);

  const panelAction = async (action: "close" | "return") => {
    if (panelOperation.current) return;
    const operation = { sessionId: panelView?.sessionId, revision: panelRevision.current };
    panelOperation.current = operation;
    const currentOperation = () =>
      mounted.current &&
      panelOperation.current === operation &&
      panelRevision.current === operation.revision;
    setPanelBusy(true);
    try {
      if (action === "close") await closeContextPanel();
      else {
        const result = await returnFromContextPanel();
        if (!result.restored && currentOperation()) setError(t("contextPanel.returnFailed"));
      }
    } catch {
      if (currentOperation()) setError(t("contextPanel.operationFailed"));
    } finally {
      if (currentOperation()) {
        panelOperation.current = undefined;
        setPanelBusy(false);
      }
    }
  };

  // Runtime cold-start notifications do not restart a live query. Catalog,
  // capability, locale and actual input changes still create a new generation.
  const queryStateKey = JSON.stringify([
    state?.pluginsReady,
    state?.catalogSignature,
    state?.commands,
    state?.modeOptions,
    isContextPanel ? undefined : state?.contextLabel,
    isContextPanel ? undefined : state?.contextRevision,
    state?.preferenceRevision,
    state?.learning?.enabled,
    isContextPanel ? panelView?.revision : undefined,
    i18n.resolvedLanguage,
  ]);
  useEffect(() => {
    const generation = ++queryGeneration.current;
    setResult(undefined);
    setSelected("");
    if (
      !state ||
      composing ||
      workspace ||
      (isContextPanel && (!panelView || panelView.status === "capturing"))
    ) {
      setLoading(false);
      if (workspace) setQueryError(undefined);
      return;
    }
    const sessionId = crypto.randomUUID();
    let requestId: string | undefined;
    let revision = -1;
    let live = true;
    const accept = (next: LauncherQueryResult) => {
      if (
        !live ||
        !mounted.current ||
        generation !== queryGeneration.current ||
        next.sessionId !== sessionId
      )
        return;
      if (requestId && next.requestId !== requestId) return;
      const nextRevision = next.revision ?? 0;
      if (nextRevision <= revision) return;
      requestId = next.requestId;
      revision = nextRevision;
      setResult(next);
      setQueryError(undefined);
      setSelected((current) =>
        current && next.items.some((item) => itemKey(item) === current)
          ? current
          : next.items[0]
            ? itemKey(next.items[0])
            : "",
      );
      setLoading(false);
    };
    // Subscribe before dispatch. A fast provider event may precede the initial
    // IPC response; revision checks prevent that response rolling the UI back.
    const subscription = listen<LauncherQueryResult>("launcher-query-updated", (event) =>
      accept(event.payload),
    );
    setLoading(true);
    const timer = setTimeout(
      () => {
        void subscription
          .then(() => {
            if (!live) return;
            return queryLauncher(query, sessionId, mode?.key, directory).then(accept);
          })
          .catch((value: unknown) => {
            if (live && mounted.current && generation === queryGeneration.current) {
              setQueryError(message(value));
              setResult(undefined);
              setLoading(false);
            }
          });
      },
      query ? 100 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
      queryGeneration.current++;
      void subscription.then((stop) => stop()).catch(() => {});
      void cancelLauncherQuery(sessionId, requestId).catch(() => {});
    };
  }, [query, mode?.key, directory, scopeRevision, queryStateKey, composing, workspace]);

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
    if (isContextPanel) {
      void panelAction("close");
      return;
    }
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
        actionItem ||
        previewOpen
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
    if (
      composition.current ||
      !state?.pluginsReady ||
      item.unavailable ||
      panelBusy ||
      (isContextPanel && (!panelView || panelView.status === "capturing"))
    )
      return;
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
    const generation = ++queryGeneration.current;
    try {
      const value = await executeLauncherItem(item);
      if (mounted.current && generation === queryGeneration.current) acceptResult(value);
    } catch (value) {
      if (mounted.current && generation === queryGeneration.current) setError(message(value));
    } finally {
      tasks.current.delete(key);
      if (mounted.current) setExecuting([...tasks.current]);
    }
  };
  const selectAction = async (item: LauncherItem, action: LauncherItemAction) => {
    if (
      !state?.pluginsReady ||
      composition.current ||
      item.unavailable ||
      panelBusy ||
      (isContextPanel && (!panelView || panelView.status === "capturing"))
    )
      return;
    const key = JSON.stringify([item.pluginId, action.id]);
    if (tasks.current.has(key)) return;
    tasks.current.add(key);
    setExecuting([...tasks.current]);
    setActionItem(undefined);
    setError(undefined);
    const generation = ++queryGeneration.current;
    try {
      const value = await executeLauncherAction(item, action);
      if (mounted.current && generation === queryGeneration.current) acceptResult(value);
    } catch (value) {
      if (mounted.current && generation === queryGeneration.current) setError(message(value));
    } finally {
      tasks.current.delete(key);
      if (mounted.current) setExecuting([...tasks.current]);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('[data-slot="context-menu-content"]')) return;
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
      if (item && !item.unavailable && (item.actions?.length || item.preference)) {
        event.preventDefault();
        event.stopPropagation();
        setActionItem(item);
        setPreferenceError(undefined);
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
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const fromInput = event.target === input.current;
      if (fromInput && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
      const target = event.target as HTMLElement;
      if (target.closest("button")) return;
      // cmdk provides linear navigation; use the rendered rows for this grid so
      // resizing the window does not leave keyboard selection on the wrong row.
      const grid = event.currentTarget.querySelector('[data-query-group="applications"]');
      const current = fromInput
        ? grid?.querySelector<HTMLElement>('[aria-selected="true"]')
        : target.closest<HTMLElement>("[data-result-key]");
      if (!current || !grid?.contains(current)) return;
      const cards = Array.from(
        grid.querySelectorAll<HTMLElement>('[data-result-key]:not([aria-disabled="true"])'),
      );
      const index = cards.indexOf(current);
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      let next: HTMLElement | undefined;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        next = cards[index + (event.key === "ArrowRight" ? 1 : -1)];
      } else {
        const origin = current.getBoundingClientRect();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        next = cards
          .map((card) => ({ card, rect: card.getBoundingClientRect() }))
          .filter(({ rect }) => direction * (rect.top - origin.top) > 1)
          .sort(
            (a, b) =>
              Math.abs(a.rect.top - origin.top) - Math.abs(b.rect.top - origin.top) ||
              Math.abs(a.rect.left - origin.left) - Math.abs(b.rect.left - origin.left),
          )[0]?.card;
        if (!next && direction === 1)
          next =
            event.currentTarget.querySelector<HTMLElement>(
              '[data-query-group]:not([data-query-group="applications"]) [data-result-key]:not([aria-disabled="true"])',
            ) ?? undefined;
        if (!next && direction === -1) input.current?.focus();
      }
      if (next) {
        setSelected(next.dataset.resultKey ?? "");
        if (!fromInput) next.focus();
        next.scrollIntoView({ block: "nearest", inline: "nearest" });
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

  const acceptPreferenceState = (next: LauncherState, generation: number, queryVersion: number) => {
    if (mounted.current && generation === stateGeneration.current) {
      stateSnapshot.current = next;
      setState(next);
      setStateError(undefined);
      if (queryVersion === queryGeneration.current) {
        queryGeneration.current++;
        setQueryError(undefined);
        setPreferenceError(undefined);
        setResult(undefined);
        setSelected("");
      }
    }
  };
  const applyPreference = async (mutation: LauncherPreferenceMutation): Promise<LauncherState> => {
    const generation = ++stateGeneration.current;
    const queryVersion = queryGeneration.current;
    const originalActionItem = actionItem;
    const next = await updateLauncherPreference(mutation);
    if (mounted.current && originalActionItem) {
      setActionItem((current) => (current === originalActionItem ? undefined : current));
    }
    acceptPreferenceState(next, generation, queryVersion);
    return next;
  };
  const mutateItemPreference = async (
    item: LauncherItem,
    operation: LauncherPreferenceMutation["operation"],
  ) => {
    if (!item.preference || preferenceBusy) return;
    setPreferenceBusy(true);
    setPreferenceError(undefined);
    try {
      const target = state?.preferences?.some((entry) => entry.key === item.preference!.key)
        ? { key: item.preference.key }
        : { selectionId: item.id };
      await applyPreference({ ...target, operation });
      focusInput();
    } catch (value) {
      setPreferenceError(message(value));
      if (!actionItem) setError(message(value));
    } finally {
      setPreferenceBusy(false);
    }
  };
  const editItemAliases = (item: LauncherItem) => {
    if (!item.preference) return;
    setActionItem(undefined);
    void openSettingsWindow({ page: "entries" }).catch((value) => setError(message(value)));
  };
  const openSettings = () => openSettingsWindow().catch((value) => setError(message(value)));

  const modeCommand = mode
    ? state?.commands.find((command) => command.mode === mode.key)
    : undefined;
  const modeTitle = mode ? (modeCommand?.title ?? mode.title) : undefined;
  const resultHint =
    modeCommand?.pluginId === "spark233.applications"
      ? applicationStatus(result?.hint)
      : result?.hint;
  const modeOptions = mode ? state?.modeOptions?.[mode.key] : undefined;
  const pluginEntries = new Map<string, string>();
  for (const command of state?.commands ?? [])
    if (command.enabled && !pluginEntries.has(command.pluginId))
      pluginEntries.set(command.pluginId, pluginEntryCommands[command.pluginId] ?? command.id);
  const isGridEntry = (item: LauncherItem) =>
    item.kind === "application" ||
    item.preference?.kind === "application" ||
    ((item.kind === "command" || item.preference?.kind === "command") &&
      item.commandId === pluginEntries.get(item.pluginId));
  const gridItems = result?.items.filter(isGridEntry) ?? [];
  const renderItem = (item: LauncherItem, grid = false) => {
    const command = findCommand(item);
    const key = itemKey(item);
    const isMode = !mode && !!command?.mode;
    const card = (
      <CommandItem
        tabIndex={0}
        data-result-key={key}
        onFocus={() => setSelected(key)}
        className={
          grid
            ? "min-h-18 min-w-0 flex-col justify-center gap-1 rounded-lg px-2 py-1.5 text-center [&>svg:last-child]:hidden"
            : undefined
        }
        title={grid ? item.title : undefined}
        key={key}
        value={key}
        disabled={
          !state?.pluginsReady ||
          panelBusy ||
          (isContextPanel && (!panelView || panelView.status === "capturing")) ||
          item.unavailable ||
          command?.enabled === false ||
          executing.includes(key)
        }
        onSelect={() => {
          void selectItem(item);
        }}
      >
        {item.kind === "command" || item.preference?.kind === "command" ? (
          <PluginIcon pluginId={item.pluginId} className="size-7 shrink-0 text-primary" />
        ) : item.icon && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(item.icon) ? (
          <img
            src={item.icon}
            alt=""
            className="size-7 shrink-0 object-contain"
            width={28}
            height={28}
          />
        ) : grid ? (
          <AppWindowIcon aria-hidden="true" className="size-7 shrink-0 text-muted-foreground" />
        ) : null}
        <div
          className={
            grid ? "flex w-full min-w-0 flex-col gap-0.5" : "flex min-w-0 flex-1 flex-col gap-0.5"
          }
        >
          <span
            className={
              grid
                ? "block h-8 overflow-hidden break-words whitespace-normal text-center text-xs leading-4 text-balance"
                : "flex items-center gap-2 truncate"
            }
          >
            {item.title}
            {!grid && item.preference?.pinned && (
              <Badge variant="secondary">{t("launcher.preferences.pinned")}</Badge>
            )}
            {!grid && item.unavailable && (
              <Badge variant="outline">{t("launcher.preferences.unavailable")}</Badge>
            )}
            {!grid && item.usage && (
              <Badge variant="outline">
                {item.usage.count > 1 ? t("launcher.frequentlyUsed") : t("launcher.recentlyUsed")}
              </Badge>
            )}
          </span>
          {!grid && item.learned && (
            <Badge
              variant="outline"
              className="h-auto max-w-full self-start whitespace-normal py-0.5"
              title={t("launcher.learning.learned")}
            >
              {t("launcher.learning.learned")}
            </Badge>
          )}
          {!grid && item.description && (
            <span className="truncate text-xs text-muted-foreground">{item.description}</span>
          )}
        </div>
        {!grid && !item.unavailable && (!!item.actions?.length || item.preference) && (
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
              setPreferenceError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          >
            <MoreHorizontalIcon />
          </Button>
        )}
        {grid ? null : executing.includes(key) ? (
          <Spinner />
        ) : item.unavailable ? null : isMode ? (
          <CommandShortcut>
            <ArrowRightIcon aria-label={t("launcher.enterMode", { defaultValue: "进入模式" })} />
          </CommandShortcut>
        ) : (
          <CommandShortcut>↵</CommandShortcut>
        )}
      </CommandItem>
    );
    if (!grid || (!item.preference && !item.actions?.length)) return card;
    return (
      <ContextMenu key={key}>
        <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
        <ContextMenuContent onKeyDown={(event) => event.stopPropagation()}>
          <ContextMenuGroup>
            {item.preference && (
              <>
                <ContextMenuItem
                  disabled={preferenceBusy || !state?.pluginsReady}
                  onSelect={() =>
                    void mutateItemPreference(item, item.preference!.pinned ? "unpin" : "pin")
                  }
                >
                  <PinIcon />
                  {t(
                    item.preference.pinned
                      ? "launcher.preferences.unpin"
                      : "launcher.preferences.pin",
                  )}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={preferenceBusy || !state?.pluginsReady}
                  onSelect={() => editItemAliases(item)}
                >
                  {t("launcher.preferences.editAliases")}
                </ContextMenuItem>
                {item.preference.kind === "command" && (
                  <ContextMenuItem
                    disabled={preferenceBusy || !state?.pluginsReady}
                    onSelect={() =>
                      void mutateItemPreference(item, item.preference!.hidden ? "show" : "hide")
                    }
                  >
                    {t(
                      item.preference.hidden
                        ? "launcher.preferences.show"
                        : "launcher.preferences.hide",
                    )}
                  </ContextMenuItem>
                )}
              </>
            )}
            {item.actions?.map((action) => (
              <ContextMenuItem
                key={action.id}
                disabled={!state?.pluginsReady || item.unavailable || preferenceBusy}
                onSelect={() => void selectAction(item, action)}
              >
                {action.title}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
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
      <header className="electron-title-drag flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">
            {isContextPanel ? t("contextPanel.title") : "spark233"}
          </h1>
          {mode && <Badge variant="secondary">{modeTitle}</Badge>}
          {!isContextPanel && state?.contextLabel && (
            <Badge variant="outline">{state.contextLabel}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {isContextPanel ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={panelBusy || !panelView?.returnAvailable}
                onClick={() => {
                  void panelAction("return");
                }}
              >
                {t("contextPanel.return")}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={panelBusy}
                aria-label={t("contextPanel.close")}
                onClick={() => {
                  void panelAction("close");
                }}
              >
                <XIcon />
              </Button>
            </>
          ) : (
            <>
              {state?.contextLabel && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const generation = ++stateGeneration.current;
                    void invoke<LauncherState>("launcher_context_clear")
                      .then((next) => {
                        if (!mounted.current || generation !== stateGeneration.current) return;
                        stateSnapshot.current = next;
                        setState(next);
                      })
                      .catch((value) => {
                        if (mounted.current && generation === stateGeneration.current)
                          setError(message(value));
                      });
                  }}
                >
                  {t("launcher.clearContext", { defaultValue: "清除内容" })}
                </Button>
              )}
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
            </>
          )}
        </div>
      </header>

      {isContextPanel && (
        <section
          className="shrink-0 space-y-1 rounded-lg border p-3 text-sm"
          aria-label={t("contextPanel.contextStatus")}
        >
          <p role="status" aria-live="polite" className="flex items-center gap-2">
            {(!panelView || panelView.status === "capturing") && !panelReadFailed && <Spinner />}
            {panelReadFailed
              ? t("contextPanel.expired")
              : t(
                  panelView
                    ? `contextPanel.capture.${panelView.contextKind === "window" ? "window" : panelView.status}`
                    : "contextPanel.capture.capturing",
                )}
          </p>
          {panelView?.sourceApp && (
            <p className="break-all text-xs text-muted-foreground">
              {t("contextPanel.source", { app: panelView.sourceApp })}
            </p>
          )}
          {panelView?.reason && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(`contextPanel.reason.${panelView.reason}`)}
            </p>
          )}
        </section>
      )}
      {!isContextPanel && state?.firstRun && (
        <Card size="sm" className="shrink-0">
          <CardHeader>
            <CardTitle>
              {t("launcher.welcome.title", { defaultValue: "欢迎使用 spark233" })}
            </CardTitle>
            <CardDescription>
              {t("launcher.welcome.description", {
                defaultValue: "从这里呼出操作、进入插件模式。便签、搜索和其他能力由各自插件提供。",
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
              setScopeRevision((value) => value + 1);
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
              defaultValue: "准备完成后可执行操作，也可以先检查插件状态。",
            })}
          </AlertDescription>
        </Alert>
      )}

      <Command
        label={t("launcher.searchLabel", { defaultValue: "搜索应用、插件与操作" })}
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void openSettingsWindow({
                    page: "plugins",
                    pluginId: "spark233.search",
                    tab: "config",
                  }).catch((value) => setError(message(value)));
                }}
              >
                {searchText("title")}
              </Button>
            )}
          </div>
        )}
        <CommandInput
          ref={input}
          value={query}
          disabled={isContextPanel && (panelBusy || !panelView || panelView.status === "capturing")}
          onValueChange={(value) => {
            setQuery(value);
            setError(undefined);
            setQueryError(undefined);
          }}
          autoFocus
          aria-label={
            mode
              ? `${modeTitle} ${t("launcher.input", { defaultValue: "查询" })}`
              : t("launcher.searchLabel", { defaultValue: "搜索应用、插件与操作" })
          }
          placeholder={
            mode
              ? (modeOptions?.placeholder ??
                t("launcher.modePlaceholder", {
                  title: modeTitle,
                  defaultValue: "在 {{title}} 中搜索…",
                }))
              : t("launcher.placeholder", { defaultValue: "输入应用、插件或操作关键词…" })
          }
          onCompositionStart={() => {
            composition.current = true;
            if (!isContextPanel)
              void invoke("launcher_composition", { active: true }).catch(() => {});
            setComposing(true);
          }}
          onCompositionEnd={(event) => {
            composition.current = false;
            if (!isContextPanel)
              void invoke("launcher_composition", { active: false }).catch(() => {});
            compositionEnded.current = performance.now();
            setQuery(event.currentTarget.value);
            setComposing(false);
          }}
        />
        <CommandList
          className="flex max-h-none min-h-0 flex-1 flex-col overflow-hidden"
          aria-busy={loading}
        >
          {!!gridItems.length && (
            <CommandGroup
              heading={t("launcher.applicationRegion")}
              data-query-group="applications"
              className="shrink-0 border-b pb-2 [&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] [&_[cmdk-group-items]]:gap-1.5"
            >
              {gridItems.map((item) => renderItem(item, true))}
            </CommandGroup>
          )}
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            aria-label={t("launcher.informationRegion")}
          >
            {loading && (
              <div
                className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
                role="status"
              >
                <Spinner />
                {t("launcher.searching", { defaultValue: "正在查询…" })}
              </div>
            )}
            {!loading && !composing && !result?.pending && (
              <CommandEmpty>
                {t("launcher.empty", {
                  defaultValue: "没有匹配的入口，试试其他关键词或检查插件是否启用。",
                })}
              </CommandEmpty>
            )}
            {(
              result?.groups ?? [
                {
                  id: "results",
                  title: modeTitle ?? t("launcher.results", { defaultValue: "操作与本地结果" }),
                  status: "ready",
                  items: result?.items ?? [],
                },
              ]
            )
              .map((group) => ({
                ...group,
                title: group.pluginId === "spark233.applications" ? undefined : group.title,
                hint:
                  group.pluginId === "spark233.applications" && group.status !== "error"
                    ? applicationStatus(group.hint)
                    : group.hint,
                items: group.items.filter((item) => !isGridEntry(item)),
              }))
              .filter((group) => group.items.length || group.status !== "ready" || group.hint)
              .map((group) => (
                <CommandGroup
                  key={group.id}
                  heading={group.title}
                  data-query-group={group.id}
                  aria-busy={group.status === "pending" && !group.items.length}
                >
                  {group.status === "pending" && (
                    <div
                      className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
                      role="status"
                    >
                      <Spinner />
                      {t("launcher.searching", { defaultValue: "正在查询…" })}
                    </div>
                  )}
                  {group.hint && (
                    <p
                      role="status"
                      className="break-words px-3 py-2 text-xs text-muted-foreground"
                    >
                      {group.hint}
                    </p>
                  )}
                  {group.status === "error" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setScopeRevision((value) => value + 1)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                      }}
                    >
                      {t("launcher.retry", { defaultValue: "重试" })}
                    </Button>
                  )}
                  {group.items.map((item) => renderItem(item))}
                </CommandGroup>
              ))}
          </div>
        </CommandList>
      </Command>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status">
          {resultHint ||
            t("launcher.navigation", { defaultValue: "↑ ↓ 选择 · Enter 执行 · Esc 返回或隐藏" })}
        </span>
      </footer>

      <Dialog
        open={!!actionItem}
        onOpenChange={(open) => {
          if (!open) {
            setActionItem(undefined);
            focusInput();
          }
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle className="break-words">{actionItem?.title}</DialogTitle>
            <DialogDescription>
              {t("launcher.chooseAction", {
                defaultValue: i18n.resolvedLanguage?.startsWith("en")
                  ? "Choose an action for this result."
                  : "选择此结果的操作。",
              })}
            </DialogDescription>
          </DialogHeader>
          {preferenceError && (
            <Alert variant="destructive">
              <AlertDescription className="break-words">{preferenceError}</AlertDescription>
            </Alert>
          )}
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {actionItem?.preference && (
              <>
                <Button
                  variant="outline"
                  className="justify-start"
                  disabled={preferenceBusy || !state?.pluginsReady}
                  onClick={() =>
                    void mutateItemPreference(
                      actionItem,
                      actionItem.preference!.pinned ? "unpin" : "pin",
                    )
                  }
                >
                  <PinIcon aria-hidden="true" />
                  {t(
                    actionItem.preference.pinned
                      ? "launcher.preferences.unpin"
                      : "launcher.preferences.pin",
                  )}
                </Button>
                <Button
                  variant="outline"
                  className="justify-start"
                  disabled={preferenceBusy || !state?.pluginsReady}
                  onClick={() => editItemAliases(actionItem)}
                >
                  {t("launcher.preferences.editAliases")}
                </Button>
                {actionItem.preference.kind === "command" && actionItem.kind !== "application" && (
                  <Button
                    variant="outline"
                    className="justify-start"
                    disabled={preferenceBusy || !state?.pluginsReady}
                    onClick={() =>
                      void mutateItemPreference(
                        actionItem,
                        actionItem.preference!.hidden ? "show" : "hide",
                      )
                    }
                  >
                    {t(
                      actionItem.preference.hidden
                        ? "launcher.preferences.show"
                        : "launcher.preferences.hide",
                    )}
                  </Button>
                )}
              </>
            )}
            {actionItem?.actions?.map((action) => (
              <Button
                key={action.id}
                variant="outline"
                className="justify-start"
                disabled={
                  !state?.pluginsReady ||
                  preferenceBusy ||
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
    </main>
  );
}

export default Launcher;
