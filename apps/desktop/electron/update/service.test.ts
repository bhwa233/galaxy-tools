import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateInfo } from "electron-updater";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import type { UpdateInfoAndProvider } from "electron-updater/out/AppUpdater.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { UpdateService, type UpdateServiceOptions } from "./service.js";

const require = createRequire(import.meta.url);
const { AppUpdater } = require("electron-updater") as typeof import("electron-updater");
const { GitHubProvider } =
  require("electron-updater/out/providers/GitHubProvider.js") as typeof import("electron-updater/out/providers/GitHubProvider.js");
const info = (version = "0.0.3", sha512 = "fixture-digest"): UpdateInfo => ({
  version,
  releaseDate: "2026-11-02T00:00:00Z",
  files: [{ url: `spark233-${version}-x64.exe`, sha512, size: 100 }],
  path: `spark233-${version}-x64.exe`,
  sha512,
});

// Keep the library's channel setter and version/rollout checks real. Only
// metadata lookup, binary downloads and OS installation use offline fixtures.
class OfflineUpdater extends AppUpdater {
  info = info();
  lookup = vi.fn(async () => this.info);
  downloadUpdate = vi.fn(async () => ["fixture-update.exe"]);
  quitAndInstall = vi.fn();
  constructor(root: string, version: string) {
    const app: AppAdapter = {
      version,
      name: "update-fixture",
      isPackaged: true,
      appUpdateConfigPath: path.join(root, "app-update.yml"),
      userDataPath: root,
      baseCachePath: root,
      whenReady: async () => {},
      relaunch() {},
      quit() {},
      onQuit() {},
    };
    super(undefined, app);
    this.isUserWithinRollout = () => true;
  }
  protected async getUpdateInfoAndProvider(): Promise<UpdateInfoAndProvider> {
    return { info: await this.lookup(), provider: {} as UpdateInfoAndProvider["provider"] };
  }
  protected async doDownloadUpdate(): Promise<never> {
    throw new Error("Downloads must use the fixture transport");
  }
}

const fixtures: Array<{ service: UpdateService; root: string }> = [];
function fixture(
  version = "0.0.2",
  requestInstall: UpdateServiceOptions["requestInstall"] = async (apply) => apply(),
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-update-"));
  const updater = new OfflineUpdater(root, version);
  const service = new UpdateService({
    configDir: root,
    hostVersion: version,
    isPackaged: true,
    platform: "win32",
    updater,
    emit: vi.fn(),
    requestInstall,
  });
  fixtures.push({ service, root });
  return { service, updater };
}
afterEach(() => {
  for (const { service, root } of fixtures.splice(0)) {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

it("rejects downgrades after channel changes and honors updater eligibility", async () => {
  const { service, updater } = fixture();
  updater.info = info("0.0.1");
  // Setting channel previously enabled downgrades, including after saving settings.
  for (const channel of ["stable", "beta", "stable"] as const) {
    service.settingsSave({ ...service.settingsGet(), channel });
    expect((await service.check(true)).status).toBe("notAvailable");
    expect(service.status().status).toBe("idle");
  }
  updater.info = info();
  updater.isUpdateSupported = () => false;
  expect((await service.check(true)).status).toBe("notAvailable");
});

it("finds beta releases with the real GitHub provider and invalidates them on channel switch", async () => {
  const { service, updater } = fixture("0.0.2-beta.1");
  const beta = info("0.0.3-beta.1");
  const provider = new GitHubProvider(
    { provider: "github", owner: "fixture", repo: "fixture" },
    updater,
    {
      platform: "win32",
      isUseMultipleRangeRequest: false,
      executor: {
        request: async () => JSON.stringify(beta),
      } as unknown as ProviderRuntimeOptions["executor"],
    },
  );
  const feed =
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Beta</title><link href="https://github.com/fixture/fixture/releases/tag/v0.0.3-beta.1"/><content>Beta notes</content></entry></feed>';
  vi.spyOn(
    provider as unknown as { httpRequest(): Promise<string> },
    "httpRequest",
  ).mockResolvedValue(feed);
  updater.lookup.mockImplementation(() => provider.getLatestVersion());
  service.settingsSave({ ...service.settingsGet(), channel: "beta" });
  expect((await service.check(true)).latestVersion).toBe(beta.version);
  expect(service.status().status).toBe("available");
  await service.download();
  service.settingsSave({ ...service.settingsGet(), channel: "stable", allowPrerelease: true });
  expect(service.settingsGet().allowPrerelease).toBe(false);
  expect(service.status()).toMatchObject({ status: "idle", channel: "stable" });
  await expect(service.install()).rejects.toMatchObject({ code: "updateDownloadNotReady" });
  updater.lookup.mockImplementation(async () => info("0.0.1"));
  expect((await service.check(true)).status).toBe("notAvailable");
});

it("keeps an auto-downloaded package installable after rechecking and a network failure", async () => {
  const { service, updater } = fixture();
  service.settingsSave({ ...service.settingsGet(), autoDownload: true });
  await service.check(true);
  await vi.waitFor(() => expect(service.status().status).toBe("downloaded"));
  const downloadedAt = service.status().downloadedAt;
  await service.check(true);
  expect(service.status()).toMatchObject({ status: "downloaded", downloadedAt });
  expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  // A later network failure previously removed the pending install action.
  updater.lookup.mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"));
  expect((await service.check(true)).status).toBe("failed");
  expect(service.status()).toMatchObject({ status: "downloaded", downloadedAt });
  await service.install();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
});

it("invalidates the downloaded receipt when the version or package digest changes", async () => {
  for (const replacement of [info("0.0.4"), info("0.0.3", "replacement-digest")]) {
    const { service, updater } = fixture();
    await service.check(true);
    await service.download();
    updater.info = replacement;
    await service.check(true);
    expect(service.status()).toMatchObject({ status: "available", downloadedAt: null });
    await expect(service.install()).rejects.toMatchObject({ code: "updateDownloadNotReady" });
  }
});

it("skips automatic checks with a downloaded update pending", async () => {
  vi.useFakeTimers();
  const { service, updater } = fixture();
  service.start();
  await service.check(true);
  await service.download();
  const queries = updater.lookup.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000 + 24 * 3600_000);
  expect(updater.lookup.mock.calls.length).toBe(queries);
  expect(service.status().status).toBe("downloaded");
});

it("fences checks, channel changes and installation across in-flight work and failed saves", async () => {
  const save = Promise.withResolvers<void>();
  const { service, updater } = fixture("0.0.2", async (apply) => {
    await save.promise;
    apply();
  });
  const betaSettings = { ...service.settingsGet(), channel: "beta" as const };
  const lookup = Promise.withResolvers<UpdateInfo>();
  updater.lookup.mockReturnValueOnce(lookup.promise);
  const first = service.check(true);
  const joined = service.check(true);
  expect(() => service.settingsSave(betaSettings)).toThrow();
  await expect(service.install()).rejects.toMatchObject({ code: "updateAlreadyRunning" });
  lookup.resolve(info());
  await Promise.all([first, joined]);
  expect(updater.lookup).toHaveBeenCalledOnce();
  const bytes = Promise.withResolvers<string[]>();
  updater.downloadUpdate.mockReturnValueOnce(bytes.promise);
  const downloading = service.download();
  await expect(service.check(true)).rejects.toMatchObject({ code: "updateAlreadyRunning" });
  expect(() => service.settingsSave(betaSettings)).toThrow();
  service.cancel();
  // Cancellation changes the display immediately; the task must still settle.
  await expect(service.check(true)).rejects.toMatchObject({ code: "updateAlreadyRunning" });
  bytes.resolve([]);
  await downloading;
  await service.download();
  const installation = service.install();
  await expect(service.check(true)).rejects.toMatchObject({ code: "updateAlreadyRunning" });
  expect(() => service.settingsSave(betaSettings)).toThrow();
  const rejected = expect(installation).rejects.toThrow("save failed");
  save.reject(new Error("save failed"));
  await rejected;
  expect(service.status().status).toBe("downloaded");
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
