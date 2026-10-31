import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SlidingButtonGroup } from "../../components/SlidingButtonGroup";
import { listen, type UnlistenFn } from "../../platform/desktop";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateSettings,
  getUpdateStatus,
  installUpdate,
  saveUpdateSettings,
} from "./api";
import { getUpdateErrorMessage } from "./updateErrors";
import type { UpdateChannel, UpdateDownloadProgress, UpdateSettings, UpdateState } from "./types";

interface UpdateSettingsSectionProps {
  mode?: "settingsOnly" | "checkOnly" | "full";
}

type UpdateAction = "check" | "download" | "install";

const MIN_CHECK_INTERVAL_HOURS = 1;
const MAX_CHECK_INTERVAL_HOURS = 24 * 7;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${exponent === 0 || scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[exponent]}`;
}

// Labels that do not have a key in every locale yet fall back to their zh-CN default,
// following the same convention as getUpdateErrorMessage.
function translateOptional(translate: TFunction, key: string, defaultValue: string): string {
  return translate(key, { defaultValue });
}

function getStatusLabel(status: UpdateState, translate: TFunction): string | null {
  switch (status.status) {
    case "checking":
      return translate("settings.update.checking", { defaultValue: "正在检查..." });
    case "available":
      return translate("settings.update.latestVersion", {
        version: status.latestVersion ?? "",
        defaultValue: "待更新版本：{{version}}",
      });
    case "downloading":
      return translate("settings.update.busy", { defaultValue: "处理中" });
    case "downloaded":
      return translate("settings.update.downloaded", {
        version: status.latestVersion ?? "",
        defaultValue: "版本 {{version}} 已下载完成",
      });
    case "installing":
      return translate("settings.update.installPreparing", {
        defaultValue: "正在准备退出应用并安装更新...",
      });
    case "installScheduled":
      return translate("settings.update.installScheduled", {
        defaultValue: "检测到旧版待安装状态...",
      });
    case "failed":
      return status.lastError
        ? getUpdateErrorMessage(status.lastError, translate)
        : translate("settings.update.installFailed", { defaultValue: "更新失败，请重试" });
    case "idle":
      return status.checkedAt
        ? translate("settings.update.notAvailable", { defaultValue: "当前已是最新版本" })
        : null;
    default:
      return null;
  }
}

interface SettingsToggleRowProps {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

function SettingsToggleRow({ id, label, checked, disabled, onChange }: SettingsToggleRowProps) {
  return (
    <div className="flex h-9 items-center justify-between rounded-lg border border-paper-deep/25 bg-paper-warm/45 px-2.5">
      <Label htmlFor={id} className="text-[12px] font-normal text-ink-soft">
        {label}
      </Label>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
    </div>
  );
}

export function UpdateSettingsSection({ mode = "full" }: UpdateSettingsSectionProps) {
  const { t } = useTranslation();
  const showSettings = mode !== "checkOnly";
  const showUpdateActions = mode !== "settingsOnly";
  const aliveRef = useRef(true);
  const actionRef = useRef<UpdateAction | null>(null);
  const savingRef = useRef(false);
  const settingsRef = useRef<UpdateSettings | null>(null);
  const [status, setStatus] = useState<UpdateState | null>(null);
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [pendingAction, setPendingAction] = useState<UpdateAction | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [intervalDraft, setIntervalDraft] = useState("");

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    aliveRef.current = true;
    void getUpdateStatus()
      .then((next) => {
        if (aliveRef.current) setStatus(next);
      })
      .catch((cause) => {
        console.error("failed to load update status", cause);
        if (aliveRef.current) setActionError(cause);
      });

    if (showSettings) {
      void getUpdateSettings()
        .then((next) => {
          if (!aliveRef.current) return;
          settingsRef.current = next;
          setSettings(next);
          setIntervalDraft(String(next.checkIntervalHours));
        })
        .catch((cause) => {
          console.error("failed to load update settings", cause);
          if (aliveRef.current) setActionError(cause);
        });
    }

    return () => {
      aliveRef.current = false;
    };
  }, [showSettings]);

  useEffect(() => {
    let active = true;
    const unlistenFns: UnlistenFn[] = [];
    const disposeAll = () => {
      for (const unlisten of unlistenFns.splice(0)) {
        unlisten();
      }
    };
    const refreshStatus = () => {
      void getUpdateStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch((cause) => {
          console.error("failed to refresh update status", cause);
        });
    };

    const bindEvents = async () => {
      try {
        unlistenFns.push(
          await listen("update://checking", (event) => {
            if (active) setStatus(event.payload);
          }),
        );
        unlistenFns.push(
          await listen("update://checked", (event) => {
            if (!active) return;
            setStatus(event.payload);
            setActionError(null);
          }),
        );
        unlistenFns.push(
          await listen("update://download-finished", (event) => {
            if (!active) return;
            setStatus(event.payload);
            setProgress(null);
          }),
        );
        unlistenFns.push(
          await listen("update://install-finished", (event) => {
            if (active) setStatus(event.payload);
          }),
        );
        unlistenFns.push(
          await listen("update://download-progress", (event) => {
            if (active) setProgress(event.payload);
          }),
        );
        unlistenFns.push(
          await listen("update://error", (event) => {
            if (active) setActionError(event.payload);
          }),
        );
        unlistenFns.push(
          await listen("update://auto-check-error", (event) => {
            console.error("auto update check failed", event.payload);
            if (active) refreshStatus();
          }),
        );
      } catch (cause) {
        console.error("failed to subscribe update events", cause);
      }

      if (!active) disposeAll();
    };

    void bindEvents();

    return () => {
      active = false;
      disposeAll();
    };
  }, []);

  const runAction = async (action: UpdateAction, work: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = action;
    setPendingAction(action);
    setActionError(null);
    try {
      await work();
    } catch (cause) {
      if (aliveRef.current) setActionError(cause);
    } finally {
      actionRef.current = null;
      if (aliveRef.current) setPendingAction(null);
    }
  };

  const handleCheck = () => {
    void runAction("check", async () => {
      const result = await checkForUpdates(true);
      if (!aliveRef.current) return;

      if (result.status === "failed") {
        const next = await getUpdateStatus().catch(() => null);
        if (!aliveRef.current) return;
        if (next) setStatus(next);
        setActionError(
          next?.lastError ?? {
            message: t("settings.update.error.checkTaskJoinFailed", {
              defaultValue: "检查更新任务执行失败",
            }),
          },
        );
        return;
      }

      setStatus((current) => {
        const base: UpdateState = current ?? {
          status: "idle",
          currentVersion: result.currentVersion,
          channel: settingsRef.current?.channel ?? "stable",
        };
        return {
          ...base,
          status: result.status === "available" ? "available" : "idle",
          currentVersion: result.currentVersion,
          latestVersion: result.status === "available" ? (result.latestVersion ?? null) : null,
          checkedAt: new Date().toISOString(),
          downloadedAt: null,
          assetPath: null,
          lastError: null,
        };
      });
    });
  };

  const handleDownload = () => {
    void runAction("download", async () => {
      const result = await downloadUpdate("github");
      if (!aliveRef.current) return;
      setStatus((current) =>
        current
          ? {
              ...current,
              status: result.status,
              latestVersion: result.version ?? current.latestVersion,
              assetPath: result.assetPath ?? current.assetPath,
              source: result.source ?? current.source,
              downloadedAt:
                result.status === "downloaded" ? new Date().toISOString() : current.downloadedAt,
            }
          : current,
      );
      if (result.status !== "failed") return;
      const next = await getUpdateStatus().catch(() => null);
      if (!aliveRef.current) return;
      if (next) setStatus(next);
      setActionError(next?.lastError ?? null);
    });
  };

  const handleInstall = () => {
    void runAction("install", async () => {
      const result = await installUpdate();
      if (!aliveRef.current) return;
      setStatus((current) =>
        current
          ? {
              ...current,
              status: result.status,
              installMode: result.mode,
              installLogPath: result.logPath ?? current.installLogPath,
            }
          : current,
      );
      if (result.status !== "failed") return;
      const next = await getUpdateStatus().catch(() => null);
      if (!aliveRef.current) return;
      if (next) setStatus(next);
      setActionError(next?.lastError ?? null);
    });
  };

  const applySettings = async (patch: Partial<UpdateSettings>) => {
    const current = settingsRef.current;
    if (!current || savingRef.current) return;

    const next: UpdateSettings = { ...current, ...patch };
    savingRef.current = true;
    settingsRef.current = next;
    setSettings(next);
    setSavingSettings(true);
    setActionError(null);
    try {
      const saved = await saveUpdateSettings(next);
      if (!aliveRef.current) return;
      settingsRef.current = saved;
      setSettings(saved);
      setIntervalDraft(String(saved.checkIntervalHours));
    } catch (cause) {
      if (!aliveRef.current) return;
      settingsRef.current = current;
      setSettings(current);
      setIntervalDraft(String(current.checkIntervalHours));
      setActionError(cause);
    } finally {
      savingRef.current = false;
      if (aliveRef.current) setSavingSettings(false);
    }
  };

  const commitIntervalDraft = () => {
    const current = settingsRef.current;
    if (!current) return;
    const parsed = Number(intervalDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setIntervalDraft(String(current.checkIntervalHours));
      return;
    }
    const hours = Math.min(
      MAX_CHECK_INTERVAL_HOURS,
      Math.max(MIN_CHECK_INTERVAL_HOURS, Math.round(parsed)),
    );
    setIntervalDraft(String(hours));
    if (hours !== current.checkIntervalHours) {
      void applySettings({ checkIntervalHours: hours });
    }
  };

  const channelOptions: Array<{ value: UpdateChannel; label: string }> = [
    { value: "stable", label: t("settings.update.channel.stable", { defaultValue: "stable" }) },
    { value: "beta", label: t("settings.update.channel.beta", { defaultValue: "beta" }) },
  ];

  const versionLabel = status?.currentVersion
    ? t("settings.update.currentVersion", {
        version: status.currentVersion,
        defaultValue: "当前版本：{{version}}",
      })
    : null;
  const statusLabel = status ? getStatusLabel(status, t) : null;
  const errorText =
    actionError != null
      ? getUpdateErrorMessage(actionError, t)
      : status?.status === "failed"
        ? getUpdateErrorMessage(status.lastError ?? null, t)
        : null;
  const downloadPercent = (() => {
    if (status?.status !== "downloading" || !progress) return null;
    if (typeof progress.percent === "number" && Number.isFinite(progress.percent)) {
      return Math.max(0, Math.min(100, progress.percent));
    }
    if (typeof progress.totalBytes === "number" && progress.totalBytes > 0) {
      return Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100);
    }
    return null;
  })();
  const downloadSpeed =
    progress && progress.bytesPerSecond > 0 ? `${formatBytes(progress.bytesPerSecond)}/s` : null;

  return (
    <section
      className="space-y-3 rounded-xl border border-paper-deep/40 p-4 text-sm text-ink-soft"
      aria-label={t("settings.update.title", { defaultValue: "更新" })}
    >
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium text-ink">
          {t("settings.update.title", { defaultValue: "更新" })}
        </h3>
        {versionLabel ? <p className="text-[11px] text-ink-faint">{versionLabel}</p> : null}
      </div>

      {showSettings ? (
        settings ? (
          <div className="space-y-2">
            <SettingsToggleRow
              id="update-auto-check"
              label={t("settings.update.autoCheck", { defaultValue: "自动检查更新" })}
              checked={settings.autoCheck}
              disabled={savingSettings}
              onChange={(checked) => {
                void applySettings({ autoCheck: checked });
              }}
            />
            <SettingsToggleRow
              id="update-auto-download"
              label={t("settings.update.autoDownload", { defaultValue: "有新版本时自动下载" })}
              checked={settings.autoDownload}
              disabled={savingSettings}
              onChange={(checked) => {
                void applySettings({ autoDownload: checked });
              }}
            />
            <div className="flex h-9 items-center justify-between rounded-lg border border-paper-deep/25 bg-paper-warm/45 px-2.5">
              <Label
                htmlFor="update-check-interval"
                className="text-[12px] font-normal text-ink-soft"
              >
                {t("settings.update.interval.label", { defaultValue: "检查频率" })}
              </Label>
              <div className="flex items-center gap-1">
                <input
                  id="update-check-interval"
                  type="number"
                  min={MIN_CHECK_INTERVAL_HOURS}
                  max={MAX_CHECK_INTERVAL_HOURS}
                  step={1}
                  value={intervalDraft}
                  disabled={savingSettings}
                  onChange={(event) => setIntervalDraft(event.target.value)}
                  onBlur={commitIntervalDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitIntervalDraft();
                    }
                  }}
                  className="h-6 w-14 rounded-md border border-paper-deep/40 bg-paper-warm/70 px-1.5 text-right font-mono text-[11px] text-ink-soft outline-none focus:border-bamboo/60 disabled:opacity-50"
                />
                <span className="text-[11px] text-ink-faint">
                  {translateOptional(t, "settings.update.interval.unit", "小时")}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-ink-soft">
                {translateOptional(t, "settings.update.channelLabel", "更新通道")}
              </span>
              <SlidingButtonGroup
                options={channelOptions}
                value={settings.channel}
                onChange={(value) => {
                  void applySettings({ channel: value });
                }}
                className="min-w-[128px]"
              />
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-ink-faint">
            {t("settings.update.loading", { defaultValue: "正在读取更新设置..." })}
          </p>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={pendingAction !== null} onClick={handleCheck}>
          {pendingAction === "check"
            ? t("settings.update.checking", { defaultValue: "正在检查..." })
            : t("settings.update.check", { defaultValue: "检查更新" })}
        </Button>
        {statusLabel ? <span className="text-[11px] text-ink-faint">{statusLabel}</span> : null}
      </div>

      {status?.status === "downloading" ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="h-1.5 overflow-hidden rounded-full bg-paper-deep/30">
            <div
              className="h-full rounded-full bg-bamboo transition-[width] duration-300 ease-out"
              style={{ width: `${downloadPercent ?? 0}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-ink-faint">
            <span>
              {downloadPercent === null
                ? t("settings.update.busy", { defaultValue: "处理中" })
                : `${Math.round(downloadPercent)}%`}
            </span>
            {downloadSpeed ? (
              <span>
                {t("settings.update.speed", {
                  speed: downloadSpeed,
                  defaultValue: "速度：{{speed}}",
                })}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {showUpdateActions && status?.status === "available" ? (
        <div className="space-y-2 rounded-lg border border-bamboo/30 bg-bamboo-mist/40 p-2.5">
          <p className="text-[11px] text-ink-soft">
            {t("settings.update.available", {
              version: status.latestVersion ?? "",
              defaultValue: "发现新版本 {{version}}",
            })}
          </p>
          <Button size="sm" disabled={pendingAction !== null} onClick={handleDownload}>
            {pendingAction === "download"
              ? t("settings.update.busy", { defaultValue: "处理中" })
              : t("settings.update.download", { defaultValue: "下载更新" })}
          </Button>
        </div>
      ) : null}

      {showUpdateActions && status?.status === "downloaded" ? (
        <div className="space-y-2 rounded-lg border border-paper-deep/30 bg-paper-warm/50 p-2.5">
          <p className="text-[11px] text-ink-soft">
            {t("settings.update.downloaded", {
              version: status.latestVersion ?? "",
              defaultValue: "版本 {{version}} 已下载完成",
            })}
          </p>
          <Button size="sm" disabled={pendingAction !== null} onClick={handleInstall}>
            {pendingAction === "install"
              ? t("settings.update.installPreparing", {
                  defaultValue: "正在准备退出应用并安装更新...",
                })
              : t("settings.update.install", { defaultValue: "安装并重启" })}
          </Button>
        </div>
      ) : null}

      {errorText ? (
        <p role="alert" className="text-[11px] text-red-400">
          {errorText}
        </p>
      ) : null}

      <p className="text-[11px] text-ink-faint">
        {t("settings.update.hostInstallHint", {
          defaultValue: "主程序通过新版 spark233 安装包升级。",
        })}
      </p>
    </section>
  );
}
