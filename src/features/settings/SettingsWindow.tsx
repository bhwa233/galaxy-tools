import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Database,
  LayoutList,
  Maximize2,
  Minus,
  Package,
  Settings,
  Stethoscope,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
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
import { BackupDialog } from "../backup/BackupDialog";
import { DiagnosticsDialog } from "../diagnostics/DiagnosticsDialog";
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
  type SettingsPage,
} from "./api";
import type { AppConfig, AppConfigPatch } from "./types";

const pages = ["general", "entries", "plugins", "backup", "diagnostics"] as const;
function initialTarget(): SettingsTarget {
  const params = new URLSearchParams(location.search);
  return {
    page: pages.includes(params.get("page") as SettingsPage)
      ? (params.get("page") as SettingsPage)
      : "general",
    pluginId: params.get("pluginId") ?? undefined,
    tab: (params.get("tab") as SettingsTarget["tab"]) ?? "config",
  };
}
const icons = {
  general: Settings,
  entries: LayoutList,
  plugins: Package,
  backup: Database,
  diagnostics: Stethoscope,
};
export function SettingsWindow() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<SettingsTarget>(initialTarget);
  const [config, setConfig] = useState<AppConfig>();
  const [state, setState] = useState<LauncherState>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [migrationTarget, setMigrationTarget] = useState<string>();
  const [migrating, setMigrating] = useState(false);
  const [retry, setRetry] = useState(0);
  const hostPending = useRef<AppConfigPatch>({});
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const text = (value: unknown) =>
    value && typeof value === "object" && "message" in value
      ? String(value.message)
      : String(value);
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
    const configListener = listen<AppConfig>("config-changed", ({ payload }) =>
      setConfig({ ...payload, ...hostPending.current }),
    );
    const targetListener = listen<SettingsTarget>("settings-navigate", ({ payload }) => {
      if (pages.includes(payload.page as SettingsPage)) setTarget(payload);
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
      void targetListener.then((fn) => fn());
    };
  }, [retry, t]);
  const navigate = async (next: SettingsTarget) => {
    try {
      await prepareHostWindow();
      setTarget(next);
      setError(undefined);
    } catch {
      /* The relevant editor owns its save decision. */
    }
  };
  const change = (patch: AppConfigPatch) => {
    hostPending.current = { ...hostPending.current, ...patch };
    setConfig((current) => (current ? { ...current, ...patch } : current));
    setSaving(true);
    const operation = writes.current
      .catch(() => {})
      .then(async () => {
        const submitted = { ...hostPending.current };
        if (!Object.keys(submitted).length) return;
        const value = await patchConfig(submitted);
        for (const key of Object.keys(submitted) as (keyof AppConfigPatch)[])
          if (JSON.stringify(hostPending.current[key]) === JSON.stringify(submitted[key]))
            delete hostPending.current[key];
        if (mounted.current) {
          setConfig({ ...value, ...hostPending.current });
          setError(undefined);
        }
      });
    writes.current = operation;
    void operation
      .catch((value) => {
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
          <p className="mt-auto px-3 py-2 text-xs text-muted-foreground">
            {t("settingsEditor.savePolicy")}
          </p>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (config ? change({}) : setRetry((value) => value + 1))}
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
                  <p role="status" className="text-xs text-muted-foreground">
                    {saving ? t("launcher.preferences.saving") : t("settingsEditor.autoSave")}
                  </p>
                </>
              )}
              {page === "plugins" && (
                <PluginManagementDialog
                  embedded
                  open
                  pluginId={target.pluginId}
                  initialTab={target.tab}
                  onOpenChange={() => {}}
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
              {page !== "general" && (
                <Button
                  className="self-start"
                  variant="ghost"
                  size="sm"
                  disabled={migrating}
                  onClick={() => {
                    void navigate({ page: "general" });
                  }}
                >
                  <ArrowLeft />
                  {t("settingsEditor.backGeneral")}
                </Button>
              )}
            </>
          )}
        </div>
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
