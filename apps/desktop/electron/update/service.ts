import { createRequire } from "node:module";
import path from "node:path";
import type { AppUpdater, CancellationToken, UpdateInfo } from "electron-updater";

// electron-updater only ships CommonJS; a static named import fails under
// Electron's ESM loader ("does not provide an export named 'autoUpdater'").
const electronUpdater = createRequire(import.meta.url)(
  "electron-updater",
) as typeof import("electron-updater");
const autoUpdater = electronUpdater.autoUpdater;
import type {
  InstallKind,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateErrorPayload,
  UpdateInstallResult,
  UpdateSettings,
  UpdateState,
} from "../../src/features/update/types.js";
import { AppError } from "../persistence.js";
import { normalizeUpdateSettings, UpdateSettingsStore } from "./settings.js";

export interface UpdateServiceOptions {
  configDir: string;
  hostVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  emit: (name: string, payload?: unknown) => void;
  /** Runs the save barrier and calls `apply` only after every window confirmed saving. */
  requestInstall: (apply: () => void) => Promise<void>;
}

const CHECKING_EVENT = "update://checking";
const CHECKED_EVENT = "update://checked";
const DOWNLOAD_FINISHED_EVENT = "update://download-finished";
const INSTALL_FINISHED_EVENT = "update://install-finished";
const ERROR_EVENT = "update://error";
const AUTO_CHECK_ERROR_EVENT = "update://auto-check-error";
const FIRST_AUTO_CHECK_DELAY_MS = 30_000;

function detectInstallKind(isPackaged: boolean, platform: NodeJS.Platform): InstallKind {
  if (platform !== "win32") return "unknown";
  if (process.env.PORTABLE_EXECUTABLE_DIR) return "windowsPortable";
  const windowsStore = (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore;
  if (windowsStore === true) return "windowsMsix";
  return isPackaged ? "windowsNsis" : "unknown";
}

function releaseNotesText(info: UpdateInfo): string | null {
  const notes = info.releaseNotes;
  if (!notes) return null;
  if (typeof notes === "string") return notes;
  return notes
    .map((note) => (note.version ? `${note.version}\n${note.note ?? ""}` : (note.note ?? "")))
    .join("\n\n");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(message: string, fallback: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("net::") ||
    lower.includes("enotfound") ||
    lower.includes("econn") ||
    lower.includes("etimedout") ||
    lower.includes("socket")
  )
    return "updateDownloadNetwork";
  if (lower.includes("app-update.yml") || lower.includes("app-update"))
    return "updateProviderNotConfigured";
  if (lower.includes("sha512") || lower.includes("checksum") || lower.includes("signature"))
    return "updateDownloadHashMismatch";
  if (lower.includes("already")) return "updateAlreadyRunning";
  return fallback;
}

/**
 * Owns the host update state machine on top of electron-updater.
 * GitHub Releases is the only provider: the MirrorChyan surface of the shared
 * contract is kept for compatibility but returns empty values.
 */
export class UpdateService {
  private readonly store: UpdateSettingsStore;
  private readonly updater: AppUpdater;
  private state: UpdateState;
  private settings: UpdateSettings;
  private checkTask?: Promise<UpdateCheckResult>;
  private downloadTask?: Promise<UpdateDownloadResult>;
  private downloadToken?: CancellationToken;
  private downloadCancelled = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: UpdateServiceOptions) {
    this.store = new UpdateSettingsStore(options.configDir);
    this.settings = this.store.value;
    this.updater = autoUpdater;
    this.state = {
      status: "idle",
      currentVersion: options.hostVersion,
      channel: this.settings.channel,
      installKind: detectInstallKind(options.isPackaged, options.platform),
      installMode: null,
      lastError: null,
    };
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.applyChannel();
    this.updater.logger = {
      info: (message?: unknown) => console.log("[update]", message),
      warn: (message?: unknown) => console.warn("[update]", message),
      error: (message?: unknown) => console.error("[update]", message),
      debug: (message: string) => console.debug("[update]", message),
    };
    this.updater.on("error", this.onUpdaterError);
    this.updater.on("update-available", this.onAvailable);
    this.updater.on("update-not-available", this.onNotAvailable);
  }

  start(): void {
    this.schedule();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.downloadToken?.cancel();
    this.downloadToken = undefined;
    this.updater.off("error", this.onUpdaterError);
    this.updater.off("update-available", this.onAvailable);
    this.updater.off("update-not-available", this.onNotAvailable);
  }

  status(): UpdateState {
    return this.snapshot();
  }

  settingsGet(): UpdateSettings {
    return { ...this.settings };
  }

  settingsSave(input: UpdateSettings): UpdateSettings {
    const next = normalizeUpdateSettings(input);
    this.settings = next;
    this.store.save(next);
    this.applyChannel();
    this.schedule();
    return { ...next };
  }

  async check(manual: boolean): Promise<UpdateCheckResult> {
    if (this.checkTask) return this.checkTask;
    this.checkTask = this.runCheck(manual).finally(() => {
      this.checkTask = undefined;
    });
    return this.checkTask;
  }

  async download(source?: "mirrorChyan" | "github"): Promise<UpdateDownloadResult> {
    if (this.downloadTask) return this.downloadTask;
    if (this.state.status !== "available" && this.state.status !== "downloaded")
      throw new AppError("updateDownloadNotReady", "请先检查更新");
    if (source === "mirrorChyan")
      throw new AppError("updateSourceNotConfigured", "当前仅支持 GitHub 更新源");
    this.downloadTask = this.runDownload().finally(() => {
      this.downloadTask = undefined;
    });
    return this.downloadTask;
  }

  async install(): Promise<UpdateInstallResult> {
    if (this.state.status !== "downloaded")
      throw new AppError("updateDownloadNotReady", "请先下载更新");
    const previous = this.state;
    this.state = {
      ...this.state,
      status: "installing",
      installMode: "apply",
      installStartedAt: new Date().toISOString(),
      lastError: null,
    };
    try {
      await this.options.requestInstall(() => {
        this.state = {
          ...this.state,
          status: "installScheduled",
          installScheduledAt: new Date().toISOString(),
        };
        this.emit(INSTALL_FINISHED_EVENT);
        this.updater.quitAndInstall(true, true);
      });
    } catch (error) {
      this.state = { ...previous, lastError: this.errorPayload(error, "installSaveFailed") };
      this.emit(ERROR_EVENT);
      throw error;
    }
    return { status: "installScheduled", logPath: null, mode: "apply" };
  }

  cancel(): void {
    if (this.state.status !== "downloading") return;
    this.downloadCancelled = true;
    this.downloadToken?.cancel();
    this.downloadToken = undefined;
    this.state = { ...this.state, status: "available", lastError: null };
    this.emit(CHECKED_EVENT);
  }

  setMirrorChyanCdk(_cdk: string): void {
    // GitHub-only updates: no credential is stored and no CDK error is surfaced.
  }

  mirrorChyanCdk(): string | null {
    return null;
  }

  clearMirrorChyanCdk(): void {}

  private async runCheck(manual: boolean): Promise<UpdateCheckResult> {
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      const payload: UpdateErrorPayload = {
        code: unsupported.code,
        message: unsupported.message,
        recoverable: true,
      };
      this.state = { ...this.state, status: "failed", lastError: payload };
      this.emit(manual ? ERROR_EVENT : AUTO_CHECK_ERROR_EVENT);
      return this.failedCheck();
    }
    this.state = { ...this.state, status: "checking", lastError: null };
    this.emit(CHECKING_EVENT);
    try {
      const result = await this.updater.checkForUpdates();
      const info = result?.updateInfo;
      const available = info ? info.version !== this.options.hostVersion : false;
      const checkedAt = new Date().toISOString();
      this.state = {
        ...this.state,
        status: available ? "available" : "idle",
        latestVersion: info?.version ?? null,
        checkedAt,
        assetName: info ? path.basename(info.files[0]?.url ?? "") || null : null,
        assetPath: null,
        assetSha256: null,
        assetSize: info?.files[0]?.size ?? null,
        assetUrl: info?.files[0]?.url ?? null,
        downloadedAt: null,
        lastError: null,
      };
      if (!manual) {
        this.settings = { ...this.settings, lastAutoCheckAt: checkedAt };
        try {
          this.store.save(this.settings);
        } catch (error) {
          console.error("[update] failed to persist lastAutoCheckAt", error);
        }
      }
      this.emit(CHECKED_EVENT);
      if (available && this.settings.autoDownload)
        void this.download("github").catch((error) =>
          console.error("[update] auto-download", error),
        );
      return {
        status: available ? "available" : "notAvailable",
        currentVersion: this.options.hostVersion,
        latestVersion: info?.version ?? null,
        releaseNotes: info ? releaseNotesText(info) : null,
        mandatory: false,
        canDownloadFromMirrorChyan: false,
        canDownloadFromGithub: true,
        recommendedSource: "github",
        assetUrl: info?.files[0]?.url ?? null,
      };
    } catch (error) {
      const payload = this.errorPayload(error, "updateCheckInterrupted");
      this.state = {
        ...this.state,
        status: "failed",
        latestVersion: null,
        checkedAt: new Date().toISOString(),
        lastError: payload,
      };
      this.emit(manual ? ERROR_EVENT : AUTO_CHECK_ERROR_EVENT);
      return this.failedCheck();
    }
  }

  private async runDownload(): Promise<UpdateDownloadResult> {
    if (this.state.status === "downloaded")
      return {
        status: "downloaded",
        version: this.state.latestVersion ?? null,
        assetPath: null,
        source: "github",
      };
    this.downloadCancelled = false;
    this.downloadToken = new electronUpdater.CancellationToken();
    this.state = {
      ...this.state,
      status: "downloading",
      source: "github",
      lastError: null,
    };
    this.emit(CHECKED_EVENT);
    try {
      await this.updater.downloadUpdate(this.downloadToken);
      this.downloadToken = undefined;
      if (this.downloadCancelled) {
        this.state = { ...this.state, status: "available" };
        this.emit(CHECKED_EVENT);
        return { status: "available", version: this.state.latestVersion ?? null, source: "github" };
      }
      this.state = {
        ...this.state,
        status: "downloaded",
        downloadedAt: new Date().toISOString(),
        lastError: null,
      };
      this.emit(DOWNLOAD_FINISHED_EVENT);
      return {
        status: "downloaded",
        version: this.state.latestVersion ?? null,
        assetPath: null,
        source: "github",
      };
    } catch (error) {
      this.downloadToken = undefined;
      if (this.downloadCancelled) {
        this.state = { ...this.state, status: "available" };
        this.emit(CHECKED_EVENT);
        return { status: "available", version: this.state.latestVersion ?? null, source: "github" };
      }
      const payload = this.errorPayload(error, "updateDownloadNetwork");
      this.state = { ...this.state, status: "failed", lastError: payload };
      this.emit(ERROR_EVENT);
      return { status: "failed", version: this.state.latestVersion ?? null, source: "github" };
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.options.isPackaged || !this.settings.autoCheck) return;
    const hours = Math.max(1, Math.min(24 * 30, this.settings.checkIntervalHours));
    const intervalMs = hours * 60 * 60 * 1000;
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => void this.autoCheck(), intervalMs);
      void this.autoCheck();
    }, FIRST_AUTO_CHECK_DELAY_MS);
  }

  private async autoCheck(): Promise<void> {
    if (this.checkTask || this.state.status === "downloading") return;
    try {
      await this.check(false);
    } catch (error) {
      console.error("[update] automatic check failed", error);
    }
  }

  private applyChannel(): void {
    // Release assets are published as latest.yml; beta is opted into through
    // allowPrerelease rather than a separate update channel file.
    this.updater.channel = "latest";
    this.updater.allowPrerelease =
      this.settings.channel === "beta" || this.settings.allowPrerelease;
  }

  private unsupportedReason(): { code: string; message: string } | null {
    if (this.options.platform !== "win32")
      return { code: "updatePlatformUnsupported", message: "应用内更新目前仅支持 Windows 安装版" };
    if (this.state.installKind === "windowsPortable")
      return { code: "updatePortableManualOnly", message: "便携版请手动下载新版覆盖安装" };
    if (this.state.installKind === "windowsMsix")
      return { code: "updatePlatformUnsupported", message: "Microsoft Store 版本由商店负责更新" };
    if (!this.options.isPackaged)
      return { code: "updatePlatformUnsupported", message: "应用内更新仅在安装版可用" };
    return null;
  }

  private failedCheck(): UpdateCheckResult {
    return {
      status: "failed",
      currentVersion: this.options.hostVersion,
      latestVersion: null,
      releaseNotes: null,
      mandatory: false,
      canDownloadFromMirrorChyan: false,
      canDownloadFromGithub: false,
      recommendedSource: null,
      assetUrl: null,
    };
  }

  private errorPayload(error: unknown, fallback: string): UpdateErrorPayload {
    const message = messageOf(error);
    return { code: errorCode(message, fallback), message, recoverable: true };
  }

  private emit(name: string): void {
    this.options.emit(name, this.snapshot());
  }

  private snapshot(): UpdateState {
    return {
      ...this.state,
      lastError: this.state.lastError ? { ...this.state.lastError } : null,
    };
  }

  private onUpdaterError = (error: Error): void => {
    console.error("[update]", error);
    this.state = {
      ...this.state,
      status: this.state.status === "downloading" ? "failed" : this.state.status,
      lastError: this.errorPayload(error, "updateDownloadNetwork"),
    };
  };

  private onAvailable = (info: UpdateInfo): void => {
    if (!this.state.latestVersion) this.state = { ...this.state, latestVersion: info.version };
  };

  private onNotAvailable = (): void => {
    if (this.state.status === "checking") this.state = { ...this.state, status: "idle" };
  };
}

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  return new UpdateService(options);
}
