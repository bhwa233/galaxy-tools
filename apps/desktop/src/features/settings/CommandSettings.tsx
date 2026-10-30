import { showToast } from "../../components/Toast";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, ArrowDown, ArrowUp, Search, TriangleAlert } from "lucide-react";
import { ShortcutRecorder } from "@/components/SettingsPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { listPlugins, watchPluginsChanged } from "../plugins/api";
import { PluginIcon } from "../plugins/PluginIcon";
import type { PluginSummary } from "../plugins/types";
import { patchConfig } from "./api";
import type { AppConfig, AppConfigPatch } from "./types";
import { shortcutIdentity, shortcutPlatform } from "./shortcutRecorder";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { SettingsFooter } from "./SettingsFooter";

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
          // Update/install notices belong to plugin management, not this editor.
          setError(undefined);
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
  const [pluginQuery, setPluginQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(pluginId ?? "");
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
      registered: true,
      value: effective.globalShortcut,
    },
    {
      key: "toggleVisibilityShortcut",
      title: t("settings.visibilityShortcut"),
      owner: "spark233",
      pluginId: "",
      available: true,
      registered: true,
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
          registered: true,
          value: effective.commandShortcuts?.[plugin.pluginId + ":" + command.id] ?? "",
        })),
    ),
  ];
  for (const [key, value] of Object.entries(effective.commandShortcuts ?? {})) {
    if (value && !rows.some((row) => row.key === key))
      rows.push({
        key,
        title: key,
        owner:
          plugins.find((plugin) => plugin.pluginId === key.split(":")[0])?.displayName ??
          key.split(":")[0],
        pluginId: key.split(":")[0],
        available: false,
        registered: false,
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
      showToast(t("notifications.saved", { ns: "translation" }), "success");
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
  const unavailableRows = rows.filter((row) => !row.registered);
  const selectedPlugin = plugins.find((plugin) => plugin.pluginId === selection);
  const activeGroup =
    selection && !selectedPlugin
      ? unavailableRows.some((row) => row.pluginId === selection)
        ? null
        : ""
      : selection;
  const groupRows =
    activeGroup === null
      ? unavailableRows
      : rows.filter((row) => row.registered && row.pluginId === activeGroup);
  const groupTitle =
    activeGroup === null
      ? t("commandSettings.staleBindings")
      : activeGroup === ""
        ? t("commandSettings.mainProgram")
        : selectedPlugin!.displayName;
  const visible = groupRows.filter((row) =>
    (row.owner + " " + row.title + " " + row.value)
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const visiblePlugins = plugins.filter((plugin) =>
    (plugin.displayName + " " + plugin.pluginId)
      .toLocaleLowerCase()
      .includes(pluginQuery.trim().toLocaleLowerCase()),
  );
  const selectGroup = (id: string | null) => {
    setSelection(id);
    setQuery("");
  };
  return (
    <>
      {guard.dialog}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden">
        <nav
          aria-label={t("commandSettings.pluginNavigation")}
          className="flex min-h-0 min-w-0 w-48 shrink-0 flex-col gap-2 border-r pr-4"
        >
          <Input
            className="shrink-0"
            aria-label={t("pluginConfig.findPlugin")}
            placeholder={t("pluginConfig.findPlugin")}
            value={pluginQuery}
            onChange={(event) => setPluginQuery(event.target.value)}
          />
          <Button
            variant={activeGroup === "" ? "secondary" : "ghost"}
            className="h-auto w-full min-w-0 shrink-0 justify-start whitespace-normal py-3 text-left"
            aria-current={activeGroup === "" ? "page" : undefined}
            disabled={busy}
            onClick={() => selectGroup("")}
          >
            <AppWindow className="size-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{t("commandSettings.mainProgram")}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {t("commandSettings.bindingCount", {
                  assigned: rows.filter((row) => row.registered && !row.pluginId && row.value)
                    .length,
                  total: rows.filter((row) => row.registered && !row.pluginId).length,
                })}
              </span>
            </span>
          </Button>
          <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto">
            {visiblePlugins.map((plugin) => {
              const commands = rows.filter(
                (row) => row.registered && row.pluginId === plugin.pluginId,
              );
              return (
                <Button
                  key={plugin.pluginId}
                  variant={activeGroup === plugin.pluginId ? "secondary" : "ghost"}
                  className="h-auto w-full min-w-0 shrink-0 justify-start whitespace-normal py-3 text-left"
                  aria-current={activeGroup === plugin.pluginId ? "page" : undefined}
                  disabled={busy}
                  onClick={() => selectGroup(plugin.pluginId)}
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
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("commandSettings.bindingCount", {
                        assigned: commands.filter((row) => row.value).length,
                        total: commands.length,
                      })}
                    </span>
                    {(!plugin.enabled || plugin.lastError) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(plugin.lastError ? "plugins.status.error" : "plugins.status.disabled")}
                      </span>
                    )}
                  </span>
                </Button>
              );
            })}
            {!visiblePlugins.length && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t("commandSettings.noPlugins")}
              </p>
            )}
          </div>
          {(unavailableRows.length > 0 || activeGroup === null) && (
            <Button
              variant={activeGroup === null ? "secondary" : "ghost"}
              className="h-auto w-full min-w-0 shrink-0 justify-start whitespace-normal py-3 text-left"
              aria-current={activeGroup === null ? "page" : undefined}
              disabled={busy}
              onClick={() => selectGroup(null)}
            >
              <TriangleAlert className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t("commandSettings.staleBindings")}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t("commandSettings.bindingCount", {
                    assigned: unavailableRows.length,
                    total: unavailableRows.length,
                  })}
                </span>
              </span>
            </Button>
          )}
        </nav>
        <div className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <header className="shrink-0 space-y-2">
            <div className="flex items-center gap-2">
              {activeGroup === null ? (
                <TriangleAlert className="size-5 text-muted-foreground" />
              ) : activeGroup === "" ? (
                <AppWindow className="size-5 text-primary" />
              ) : (
                <PluginIcon
                  icon={plugins.find((plugin) => plugin.pluginId === activeGroup)?.icon}
                  monochrome={
                    plugins.find((plugin) => plugin.pluginId === activeGroup)?.iconMonochrome
                  }
                  className="size-5 text-primary"
                />
              )}
              <h3 className="min-w-0 break-words text-base font-semibold">{groupTitle}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                activeGroup === null
                  ? "commandSettings.staleDescription"
                  : activeGroup === ""
                    ? "commandSettings.hostDescription"
                    : "commandSettings.pluginDescription",
              )}
            </p>
            <InputGroup>
              <InputGroupAddon>
                <Search className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t("commandSettings.search")}
                placeholder={t("commandSettings.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
          </header>
          <fieldset
            disabled={busy}
            className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto p-1"
          >
            {visible.map((row) => (
              <section
                key={row.key}
                className="grid gap-3 rounded-lg border p-4 @[520px]:grid-cols-[minmax(0,1fr)_minmax(15rem,1fr)]"
              >
                <div className="min-w-0">
                  <h4 className="break-words text-sm font-medium">{row.title}</h4>
                  {!row.registered && <p className="text-xs text-muted-foreground">{row.owner}</p>}
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
                {row.registered ? (
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
                ) : (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <kbd className="break-all rounded border bg-muted px-2 py-1 text-xs">
                      {row.value}
                    </kbd>
                    <Button variant="outline" size="sm" onClick={() => change(row.key, "")}>
                      {t("commandSettings.clearBinding")}
                    </Button>
                  </div>
                )}
              </section>
            ))}
            {!visible.length && (
              <p className="p-6 text-sm text-muted-foreground">
                {t(
                  query.trim()
                    ? "commandSettings.empty"
                    : activeGroup === null
                      ? "commandSettings.noStaleBindings"
                      : "commandSettings.noActions",
                )}
              </p>
            )}
          </fieldset>
        </div>
      </div>
      <SettingsFooter
        statusTestId="shortcut-save-status"
        status={t(
          busy
            ? "launcher.preferences.saving"
            : dirty
              ? "settingsEditor.unsaved"
              : "commandSettings.saved",
        )}
      >
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
      </SettingsFooter>
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
    </div>
  );
}
