import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  PanelsTopLeft,
  LayoutList,
  Keyboard,
  PanelBottom,
  Maximize2,
  Minus,
  Package,
  Store,
  Settings,
  Stethoscope,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { SettingsPanel } from "@/components/SettingsPanel";
import { getCurrentWindow, listen } from "../../platform/desktop";
import { PluginManagementDialog } from "../plugins/PluginManagementDialog";
import { listPlugins, watchPluginsChanged, watchPluginPackageTasks } from "../plugins/api";
import type { PluginManagementState } from "../plugins/types";
import { DEFAULT_DESKTOP_LAYER_PREFERENCES } from "../../../shared/config-schema";
import { BackupDialog } from "../backup/BackupDialog";
import { DiagnosticsDialog } from "../diagnostics/DiagnosticsDialog";
import { DesktopWidgetManager } from "../desktop-layer/DesktopWidgetManager";
import { LauncherPreferencesDialog } from "../launcher/LauncherPreferencesDialog";
import {
  getLauncherState,
  updateLauncherLearning,
  updateLauncherPreference,
} from "../launcher/api";
import type { LauncherState } from "../launcher/types";
import { registerHostPreparation, prepareHostWindow } from "../windows/hostPreparation";
import {
  chooseDataDirectory,
  getConfig,
  patchConfig,
  migrateDataDir,
  type SettingsTarget,
} from "./api";
import type { AppConfig, AppConfigPatch } from "./types";
import { CommandSettings } from "./CommandSettings";
import { SettingsFooter, SettingsFooterHost } from "./SettingsFooter";
import { getErrorMessage } from "../../platform/errors";

const pages = [
  "general",
  "shortcuts",
  "tray",
  "entries",
  "desktop",
  "plugins",
  "marketplace",
  "backup",
  "diagnostics",
] as const;
function initialTarget(): SettingsTarget {
  const params = new URLSearchParams(location.search);
  return {
    page: pages.find((page) => page === params.get("page")) ?? "general",
    pluginId: params.get("pluginId") ?? undefined,
    tab: (params.get("tab") as SettingsTarget["tab"]) ?? "config",
  };
}
const icons = {
  general: Settings,
  shortcuts: Keyboard,
  tray: PanelBottom,
  entries: LayoutList,
  desktop: PanelsTopLeft,
  plugins: Package,
  marketplace: Store,
  backup: Database,
  diagnostics: Stethoscope,
};
function withPendingConfig(value: AppConfig, patch: AppConfigPatch): AppConfig {
  return {
    ...value,
    ...patch,
    desktopLayer: {
      ...DEFAULT_DESKTOP_LAYER_PREFERENCES,
      ...value.desktopLayer,
      ...patch.desktopLayer,
    },
  };
}
export function SettingsWindow() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<SettingsTarget>(initialTarget);
  const [config, setConfig] = useState<AppConfig>();
  const [state, setState] = useState<LauncherState>();
  const [pluginSnapshot, setPluginSnapshot] = useState<PluginManagementState>();
  const pluginReads = useRef<{
    generation: number;
    value?: PluginManagementState;
    pending?: Promise<PluginManagementState>;
  }>({ generation: 0 });
  // The settings shell already owns shared configuration. Keep its public
  // plugin snapshot here as well; editors still unmount through save guards.
  const readPlugins = useCallback((refresh = false): Promise<PluginManagementState> => {
    const cache = pluginReads.current;
    if (cache.pending) return cache.pending;
    if (!refresh && cache.value) return Promise.resolve(cache.value);
    const generation = cache.generation;
    const operation = listPlugins().then((snapshot) => {
      if (generation === cache.generation) {
        cache.value = snapshot;
        setPluginSnapshot(snapshot);
      }
      return snapshot;
    });
    cache.pending = operation;
    void operation
      .finally(() => {
        if (cache.pending === operation) cache.pending = undefined;
      })
      .catch(() => {});
    return operation;
  }, []);
  useEffect(() => {
    const invalidate = () => {
      const cache = pluginReads.current;
      cache.generation++;
      cache.pending = undefined;
      cache.value = undefined;
    };
    const pluginsListener = watchPluginsChanged(() => {
      const loaded = !!pluginReads.current.value || !!pluginReads.current.pending;
      invalidate();
      if (loaded) void readPlugins().catch(() => {});
    });
    const tasksListener = watchPluginPackageTasks(invalidate);
    return () => {
      invalidate();
      void pluginsListener.then((stop) => stop());
      void tasksListener.then((stop) => stop());
    };
  }, [readPlugins]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [hasPending, setHasPending] = useState(false);
  const [migrationTarget, setMigrationTarget] = useState<string>();
  const [migrating, setMigrating] = useState(false);
  const [retry, setRetry] = useState(0);
  const hostPending = useRef<AppConfigPatch>({});
  // Keys the host refused. They are not resubmitted with later edits and do not
  // block navigation or closing; only an explicit retry submits them again.
  const rejected = useRef<AppConfigPatch>({});
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const text = (value: unknown) => getErrorMessage(value);
  useEffect(() => {
    mounted.current = true;
    void getConfig()
      .then((value) => {
        if (mounted.current) {
          setConfig(value);
          setError(undefined);
        }
      })
      .catch((value) => {
        if (mounted.current) setError(text(value));
      });
    void getLauncherState()
      .then((value) => {
        if (mounted.current) setState(value);
      })
      .catch(() => {});
    const configListener = listen("config-changed", ({ payload }) =>
      setConfig(withPendingConfig(payload, hostPending.current)),
    );
    const statusListener = listen("launcher-status-changed", () => {
      void getLauncherState()
        .then((value) => {
          if (mounted.current) setState(value);
        })
        .catch(() => {});
    });
    const targetListener = listen("settings-navigate", ({ payload }) => {
      if (pages.some((page) => page === payload.page)) setTarget(payload);
    });
    const stop = registerHostPreparation(async () => {
      await writes.current;
      if (Object.keys(hostPending.current).length)
        throw new Error(t("settingsEditor.hostSaveFailed"));
    });
    return () => {
      mounted.current = false;
      stop();
      void configListener.then((fn) => fn());
      void statusListener.then((fn) => fn());
      void targetListener.then((fn) => fn());
    };
  }, [retry, t]);
  const navigate = async (next: SettingsTarget) => {
    try {
      await prepareHostWindow();
      setTarget(next);
      setError(undefined);
    } catch (value) {
      // The editor owns its save decision; still say why navigation did not happen.
      setError(text(value));
    }
  };
  const change = (patch: AppConfigPatch) => {
    // A fresh edit of a refused key supersedes the earlier refused value.
    for (const key of Object.keys(patch) as (keyof AppConfigPatch)[]) delete rejected.current[key];
    hostPending.current = {
      ...hostPending.current,
      ...patch,
      ...(patch.desktopLayer
        ? { desktopLayer: { ...hostPending.current.desktopLayer, ...patch.desktopLayer } }
        : {}),
    };
    setHasPending(Object.keys(hostPending.current).length > 0);
    setConfig((current) => (current ? withPendingConfig(current, patch) : current));
    setSaving(true);
    let submitted: AppConfigPatch = {};
    const operation = writes.current
      .catch(() => {})
      .then(async () => {
        submitted = { ...hostPending.current };
        if (!Object.keys(submitted).length) return;
        const value = await patchConfig(submitted);
        for (const key of Object.keys(submitted) as (keyof AppConfigPatch)[])
          if (JSON.stringify(hostPending.current[key]) === JSON.stringify(submitted[key]))
            delete hostPending.current[key];
        if (mounted.current) {
          setHasPending(Object.keys(hostPending.current).length > 0);
          setConfig(withPendingConfig(value, hostPending.current));
          setError(undefined);
        }
      });
    writes.current = operation;
    void operation
      .catch(async (value) => {
        // Roll back every refused key the user has not edited again since, so one
        // rejected setting cannot keep failing every later save.
        const refused = rejected.current as Record<string, unknown>;
        const pending = hostPending.current as Record<string, unknown>;
        for (const [key, submittedValue] of Object.entries(submitted))
          if (JSON.stringify(pending[key]) === JSON.stringify(submittedValue)) {
            refused[key] = submittedValue;
            delete pending[key];
          }
        if (mounted.current) setHasPending(Object.keys(hostPending.current).length > 0);
        try {
          const current = await getConfig();
          if (mounted.current) setConfig(withPendingConfig(current, hostPending.current));
        } catch {
          /* Preserve the visible save error if the refresh also fails. */
        }
        if (mounted.current) setError(text(value));
      })
      .finally(() => {
        if (mounted.current && writes.current === operation) setSaving(false);
      });
  };
  const chooseMigration = async () => {
    try {
      await prepareHostWindow();
      const directory = await chooseDataDirectory();
      if (directory) setMigrationTarget(directory);
    } catch (value) {
      setError(text(value));
    }
  };
  const migrate = async () => {
    if (!migrationTarget || migrating) return;
    setMigrating(true);
    setError(undefined);
    try {
      const value = await migrateDataDir(migrationTarget);
      setConfig(value);
      setMigrationTarget(undefined);
    } catch (value) {
      setError(text(value));
    } finally {
      setMigrating(false);
    }
  };
  const control = (operation: () => Promise<unknown>) => {
    void operation().catch((value) => setError(text(value)));
  };
  const page = target.page ?? "general";
  const desktopPreferences = { ...DEFAULT_DESKTOP_LAYER_PREFERENCES, ...config?.desktopLayer };
  return (
    <main className="flex h-screen min-w-0 flex-col bg-background text-foreground">
      <header
        className="flex h-14 shrink-0 items-center gap-3 border-b px-5"
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as Element).closest("button"))
            control(() => getCurrentWindow().startDragging());
        }}
        onDoubleClick={(event) => {
          if (!(event.target as Element).closest("button"))
            control(() => getCurrentWindow().toggleMaximize());
        }}
      >
        <Settings className="size-4 text-primary" />
        <h1 className="text-sm font-semibold tracking-wide">
          spark233{" "}
          <span className="font-normal text-muted-foreground">/ {t("launcher.settings")}</span>
        </h1>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("settingsEditor.minimize")}
            onClick={() => control(() => getCurrentWindow().minimize())}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("settingsEditor.maximize")}
            onClick={() => control(() => getCurrentWindow().toggleMaximize())}
          >
            <Maximize2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("settings.closeTitle")}
            onClick={() => control(() => getCurrentWindow().close())}
          >
            <X />
          </Button>
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("settingsEditor.navigation")}
          className="flex w-44 shrink-0 flex-col gap-1 border-r bg-muted/20 p-3"
        >
          {pages.map((item) => {
            const Icon = icons[item];
            return (
              <Button
                key={item}
                variant={page === item ? "secondary" : "ghost"}
                className="justify-start"
                disabled={migrating}
                onClick={() => {
                  void navigate({ page: item });
                }}
              >
                <Icon />
                {t(`settingsEditor.pages.${item}`)}
              </Button>
            );
          })}
        </nav>
        <SettingsFooterHost>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-6">
            {error && (
              <Alert variant="destructive">
                <AlertDescription className="flex items-center justify-between gap-3">
                  <span>{error}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!config) return setRetry((value) => value + 1);
                      const retried = rejected.current;
                      rejected.current = {};
                      change(retried);
                    }}
                  >
                    {t("launcher.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {!config ? (
              <p role="status" className="flex gap-2">
                <Spinner />
                {t("pluginConfig.loading")}
              </p>
            ) : (
              <>
                {page === "general" && (
                  <>
                    <h2 className="text-lg font-semibold">{t("settingsEditor.pages.general")}</h2>
                    <SettingsPanel
                      presentation="content"
                      initialGroup="app"
                      config={config}
                      onChange={change}
                      onClose={() => {}}
                      onMigrateDataDir={() => {}}
                    />
                  </>
                )}
                {(page === "plugins" || page === "marketplace") && (
                  <PluginManagementDialog
                    key={page}
                    embedded
                    open
                    mode={page === "plugins" ? "configuration" : "market"}
                    onNavigate={navigate}
                    pluginId={target.pluginId}
                    initialTab={target.tab}
                    initialState={pluginSnapshot}
                    loadState={readPlugins}
                    onOpenChange={() => {}}
                  />
                )}
                {(page === "shortcuts" || page === "tray") && (
                  <CommandSettings
                    key={page + (target.pluginId ?? "")}
                    kind={page}
                    config={config}
                    onChange={change}
                    onSaved={setConfig}
                    warnings={state?.warnings}
                    pluginId={target.pluginId}
                    initialState={pluginSnapshot}
                    loadState={readPlugins}
                  />
                )}
                {page === "entries" && (
                  <LauncherPreferencesDialog
                    embedded
                    open
                    onOpenChange={() => {}}
                    entries={state?.preferences ?? []}
                    ready={!!state?.pluginsReady}
                    learning={state?.learning}
                    onLearningUpdate={async (input) => {
                      const next = await updateLauncherLearning(input);
                      setState(next);
                      return next;
                    }}
                    onMutate={async (input) => {
                      const next = await updateLauncherPreference(input);
                      setState(next);
                      return next;
                    }}
                  />
                )}
                {page === "desktop" && (
                  <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
                    <FieldSet>
                      <FieldLegend>{t("settingsEditor.pages.desktop")}</FieldLegend>
                      <FieldGroup>
                        <Field orientation="horizontal" data-disabled={saving}>
                          <Checkbox
                            id="desktop-layer-enabled"
                            checked={desktopPreferences.enabled}
                            disabled={saving}
                            onCheckedChange={(enabled) => change({ desktopLayer: { enabled } })}
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="desktop-layer-enabled">
                              {t("desktopSettings.enabled")}
                            </FieldLabel>
                            <FieldDescription>
                              {t("desktopSettings.enabledDescription")}
                            </FieldDescription>
                          </FieldContent>
                        </Field>
                        <Field
                          orientation="horizontal"
                          data-disabled={saving || !desktopPreferences.enabled}
                        >
                          <Checkbox
                            id="desktop-layer-web"
                            checked={desktopPreferences.webEnabled}
                            disabled={saving || !desktopPreferences.enabled}
                            onCheckedChange={(webEnabled) =>
                              change({ desktopLayer: { ...config.desktopLayer, webEnabled } })
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="desktop-layer-web">
                              {t("desktopSettings.webEnabled")}
                            </FieldLabel>
                          </FieldContent>
                        </Field>
                        <Field
                          orientation="horizontal"
                          data-disabled={saving || !desktopPreferences.enabled}
                        >
                          <Checkbox
                            id="desktop-layer-notes"
                            checked={desktopPreferences.notesEnabled}
                            disabled={saving || !desktopPreferences.enabled}
                            onCheckedChange={(notesEnabled) =>
                              change({ desktopLayer: { ...config.desktopLayer, notesEnabled } })
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="desktop-layer-notes">
                              {t("desktopSettings.notesEnabled")}
                            </FieldLabel>
                            <FieldDescription>
                              {t("desktopSettings.notesDescription")}
                            </FieldDescription>
                          </FieldContent>
                        </Field>
                      </FieldGroup>
                    </FieldSet>
                    <DesktopWidgetManager
                      enabled={desktopPreferences.enabled}
                      webEnabled={desktopPreferences.webEnabled}
                    />
                  </div>
                )}
                {page === "backup" && (
                  <>
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
                      <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-medium">{t("settings.dataDir")}</h2>
                        <p className="break-all text-xs text-muted-foreground">{config.dataDir}</p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={migrating}
                        onClick={() => {
                          void chooseMigration();
                        }}
                      >
                        {t("settings.selectFolder")}
                      </Button>
                    </div>
                    <BackupDialog embedded open onOpenChange={() => {}} />
                  </>
                )}
                {page === "diagnostics" && (
                  <DiagnosticsDialog embedded open onOpenChange={() => {}} />
                )}
                {(page === "general" || page === "tray" || page === "desktop") && (
                  <SettingsFooter
                    status={
                      saving
                        ? t("launcher.preferences.saving")
                        : hasPending
                          ? t("settingsEditor.unsaved")
                          : t("settingsEditor.saved")
                    }
                  />
                )}
              </>
            )}
          </div>
        </SettingsFooterHost>
      </div>
      <AlertDialog
        open={!!migrationTarget}
        onOpenChange={(open) => {
          if (!open && !migrating) setMigrationTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("launcher.migrate.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("launcher.migrate.description", { path: migrationTarget })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrating}>{t("settingsEditor.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={migrating}
              onClick={(event) => {
                event.preventDefault();
                void migrate();
              }}
            >
              {migrating && <Spinner />}
              {t("settingsEditor.continue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
