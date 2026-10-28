import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { ShortcutRecorder } from "@/components/SettingsPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { listPlugins, watchPluginsChanged } from "../plugins/api";
import type { PluginSummary } from "../plugins/types";
import { patchConfig } from "./api";
import type { AppConfig, AppConfigPatch } from "./types";
import { shortcutIdentity, shortcutPlatform } from "./shortcutRecorder";
import { useUnsavedChanges } from "./useUnsavedChanges";

export function CommandSettings({
  kind,
  config,
  onChange,
  onSaved,
  pluginId,
  warnings,
}: {
  kind: "shortcuts" | "tray";
  config: AppConfig;
  onChange: (patch: AppConfigPatch) => void;
  onSaved: (config: AppConfig) => void;
  pluginId?: string;
  warnings?: string[];
}) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginSummary[]>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true,
      generation = 0;
    const load = async () => {
      const revision = ++generation;
      try {
        const state = await listPlugins();
        if (active && revision === generation) {
          setPlugins(state.plugins);
          setError(state.error);
        }
      } catch (value) {
        if (active && revision === generation) setError((value as Error).message);
      }
    };
    const listener = watchPluginsChanged(() => {
      void load();
    });
    void load();
    return () => {
      active = false;
      void listener.then((stop) => stop());
    };
  }, [retry]);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t(`settingsEditor.pages.${kind}`)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(`commandSettings.${kind}Description`)}
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            {error}
            <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
              {t("launcher.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {kind === "shortcuts" && !!warnings?.length && (
        <Alert variant="destructive">
          <AlertDescription>{warnings.join(" · ")}</AlertDescription>
        </Alert>
      )}
      {!plugins ? (
        <p role="status">
          <Spinner />
          {t("pluginConfig.loading")}
        </p>
      ) : kind === "shortcuts" ? (
        <ShortcutEditor config={config} plugins={plugins} pluginId={pluginId} onSaved={onSaved} />
      ) : (
        <TrayEditor config={config} plugins={plugins} onChange={onChange} />
      )}
    </section>
  );
}

function ShortcutEditor({
  config,
  plugins,
  pluginId,
  onSaved,
}: {
  config: AppConfig;
  plugins: PluginSummary[];
  pluginId?: string;
  onSaved: (config: AppConfig) => void;
}) {
  const { t } = useTranslation();
  const [baseline, setBaseline] = useState(config);
  const [patch, setPatch] = useState<AppConfigPatch>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(pluginId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = Object.keys(patch).length > 0;
  const current = dirty ? baseline : config;
  const effective = {
    ...current,
    ...patch,
    commandShortcuts: { ...current.commandShortcuts, ...patch.commandShortcuts },
  };
  const rows = [
    {
      key: "globalShortcut",
      title: t("settings.launcherShortcut"),
      owner: "spark233",
      pluginId: "",
      available: true,
      value: effective.globalShortcut,
    },
    {
      key: "toggleVisibilityShortcut",
      title: t("settings.visibilityShortcut"),
      owner: "spark233",
      pluginId: "",
      available: true,
      value: effective.toggleVisibilityShortcut,
    },
    ...plugins.flatMap((plugin) =>
      plugin.commands
        .filter((command) => !command.internal)
        .map((command) => ({
          key: plugin.pluginId + ":" + command.id,
          title: command.title,
          owner: plugin.displayName,
          pluginId: plugin.pluginId,
          available:
            plugin.enabled && !plugin.lastError && !["stopping", "error"].includes(plugin.status),
          value: effective.commandShortcuts?.[plugin.pluginId + ":" + command.id] ?? "",
        })),
    ),
  ];
  for (const [key, value] of Object.entries(effective.commandShortcuts ?? {})) {
    if (value && !rows.some((row) => row.key === key))
      rows.push({
        key,
        title: key,
        owner: key.split(":")[0],
        pluginId: key.split(":")[0],
        available: false,
        value,
      });
  }
  const save = async () => {
    if (!dirty) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await patchConfig(patch, {
        expectedCommandShortcuts: Object.fromEntries(
          Object.keys(patch.commandShortcuts ?? {}).map((key) => [
            key,
            baseline.commandShortcuts?.[key] ?? "",
          ]),
        ),
        ...(patch.globalShortcut !== undefined || patch.toggleVisibilityShortcut !== undefined
          ? {
              expectedShortcuts: {
                globalShortcut: baseline.globalShortcut,
                toggleVisibilityShortcut: baseline.toggleVisibilityShortcut,
              },
            }
          : {}),
      });
      setBaseline(result);
      setPatch({});
      onSaved(result);
    } catch (value) {
      setError((value as Error).message);
      throw value;
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    setPatch({});
    setBaseline(config);
    setError(undefined);
  };
  const guard = useUnsavedChanges(dirty, save, discard);
  const change = (key: string, value: string) => {
    if (!dirty) setBaseline(config);
    setPatch((previous) => {
      if (key === "globalShortcut" || key === "toggleVisibilityShortcut") {
        const next = { ...previous, [key]: value };
        if (value === current[key]) delete next[key];
        return next;
      }
      const commands = { ...previous.commandShortcuts, [key]: value };
      if (value === (current.commandShortcuts?.[key] ?? "")) delete commands[key];
      const next: AppConfigPatch = { ...previous, commandShortcuts: commands };
      if (!Object.keys(commands).length) delete next.commandShortcuts;
      return next;
    });
  };
  const visible = rows.filter(
    (row) =>
      (!filter || row.pluginId === filter) &&
      (row.owner + " " + row.title + " " + row.value).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      {guard.dialog}
      <div className="flex flex-wrap items-center gap-2">
        <Search className="size-4 text-muted-foreground" />
        <Input
          className="min-w-48 flex-1"
          aria-label={t("commandSettings.search")}
          placeholder={t("commandSettings.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {filter && (
          <Button variant="outline" onClick={() => setFilter("")}>
            {t("commandSettings.allPlugins")}
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <fieldset disabled={busy} className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {visible.map((row) => (
          <section
            key={row.key}
            className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_minmax(15rem,1fr)]"
          >
            <div className="min-w-0">
              <h3 className="break-words text-sm font-medium">{row.title}</h3>
              <p className="text-xs text-muted-foreground">{row.owner}</p>
              <Badge variant="outline" className="mt-2">
                {t(
                  !row.available
                    ? "commandSettings.unavailable"
                    : row.value
                      ? "commandSettings.configured"
                      : "commandSettings.unassigned",
                )}
              </Badge>
            </div>
            <ShortcutRecorder
              label={row.owner + " · " + row.title}
              value={row.value}
              onChange={(value) => change(row.key, value)}
              validate={(value) => {
                const conflict = rows.find(
                  (other) =>
                    other.key !== row.key &&
                    other.value &&
                    shortcutIdentity(other.value, shortcutPlatform()) ===
                      shortcutIdentity(value, shortcutPlatform()),
                );
                return conflict
                  ? t("commandSettings.conflict", {
                      action: conflict.owner + " · " + conflict.title,
                    })
                  : undefined;
              }}
            />
          </section>
        ))}
        {!visible.length && (
          <p className="p-6 text-sm text-muted-foreground">{t("commandSettings.empty")}</p>
        )}
      </fieldset>
      <footer className="flex items-center justify-end gap-3 border-t pt-3">
        <span
          role="status"
          data-testid="shortcut-save-status"
          className="mr-auto text-xs text-muted-foreground"
        >
          {t(dirty ? "settingsEditor.unsaved" : "commandSettings.saved")}
        </span>
        <Button variant="outline" disabled={!dirty || busy} onClick={discard}>
          {t("settingsEditor.discard")}
        </Button>
        <Button
          disabled={!dirty || busy}
          onClick={() => {
            void guard.save().catch(() => {});
          }}
        >
          {busy && <Spinner />}
          {t("settingsEditor.save")}
        </Button>
      </footer>
    </>
  );
}

function TrayEditor({
  config,
  plugins,
  onChange,
}: {
  config: AppConfig;
  plugins: PluginSummary[];
  onChange: (patch: AppConfigPatch) => void;
}) {
  const { t } = useTranslation();
  const preferences = config.trayMenu ?? { hidden: [], order: [] };
  const rank = (id: string) => {
    const index = preferences.order.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const groups = plugins
    .filter((plugin) => plugin.tray?.length)
    .sort((a, b) => rank(a.pluginId) - rank(b.pluginId));
  const move = (keys: string[], index: number, offset: number) => {
    const ordered = [...keys];
    [ordered[index], ordered[index + offset]] = [ordered[index + offset], ordered[index]];
    const currentKeys = new Set(keys);
    onChange({
      trayMenu: {
        ...preferences,
        order: [...preferences.order.filter((key) => !currentKeys.has(key)), ...ordered],
      },
    });
  };
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      {groups.map((plugin, groupIndex) => {
        const items = [...(plugin.tray ?? [])].sort(
          (a, b) =>
            rank(plugin.pluginId + ":" + a.id) - rank(plugin.pluginId + ":" + b.id) ||
            (a.order ?? 0) - (b.order ?? 0),
        );
        return (
          <section key={plugin.pluginId} className="rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="mr-auto text-sm font-semibold">{plugin.displayName}</h3>
              {!plugin.enabled && (
                <Badge variant="outline">{t("commandSettings.unavailable")}</Badge>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("commandSettings.moveUp", { title: plugin.displayName })}
                disabled={groupIndex === 0}
                onClick={() =>
                  move(
                    groups.map((entry) => entry.pluginId),
                    groupIndex,
                    -1,
                  )
                }
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("commandSettings.moveDown", { title: plugin.displayName })}
                disabled={groupIndex === groups.length - 1}
                onClick={() =>
                  move(
                    groups.map((entry) => entry.pluginId),
                    groupIndex,
                    1,
                  )
                }
              >
                <ArrowDown />
              </Button>
            </div>
            {items.map((item, index) => {
              const key = plugin.pluginId + ":" + item.id;
              const title =
                item.title ??
                plugin.commands.find((command) => command.id === item.commandId)?.title ??
                item.commandId;
              return (
                <div key={item.id} className="flex items-center gap-3 border-t py-3">
                  <Checkbox
                    aria-label={t("commandSettings.showItem", { title })}
                    checked={!preferences.hidden.includes(key)}
                    onCheckedChange={(checked) =>
                      onChange({
                        trayMenu: {
                          ...preferences,
                          hidden: checked
                            ? preferences.hidden.filter((entry) => entry !== key)
                            : [...new Set([...preferences.hidden, key])],
                        },
                      })
                    }
                  />
                  <span className="mr-auto min-w-0 break-words text-sm">{title}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("commandSettings.moveUp", { title })}
                    disabled={index === 0}
                    onClick={() =>
                      move(
                        items.map((entry) => plugin.pluginId + ":" + entry.id),
                        index,
                        -1,
                      )
                    }
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("commandSettings.moveDown", { title })}
                    disabled={index === items.length - 1}
                    onClick={() =>
                      move(
                        items.map((entry) => plugin.pluginId + ":" + entry.id),
                        index,
                        1,
                      )
                    }
                  >
                    <ArrowDown />
                  </Button>
                </div>
              );
            })}
          </section>
        );
      })}
      {!groups.length && (
        <p className="p-6 text-sm text-muted-foreground">{t("commandSettings.noTray")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("settingsEditor.autoSave")}</p>
    </div>
  );
}
