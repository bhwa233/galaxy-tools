import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { UpdateSettingsSection } from "./UpdateSettingsSection";
import type { UpdateSettings, UpdateState } from "./types";

it("keeps the install action after manual checks and follows host channel and busy state", async () => {
  let status: UpdateState = {
    status: "downloaded",
    currentVersion: "0.0.2",
    latestVersion: "0.0.3",
    channel: "stable",
    downloadedAt: "2026-11-02T00:00:00Z",
  };
  let settings: UpdateSettings = {
    autoCheck: true,
    autoDownload: false,
    checkIntervalHours: 24,
    channel: "stable",
    allowPrerelease: false,
    checkSourcePreference: "githubFirst",
    downloadSourcePreference: "githubFirst",
    hasMirrorChyanCdk: false,
  };
  let fail = false;
  const desktop = installDesktopBridge({
    update_status: () => status,
    update_settings_get: () => settings,
    update_check: () => {
      desktop.emit("update://checking", { ...status, status: "checking" });
      status = {
        ...status,
        lastError: fail ? { code: "fixtureNetwork", message: "offline", recoverable: true } : null,
      };
      desktop.emit("update://checked", status);
      return {
        status: fail ? "failed" : "available",
        currentVersion: "0.0.2",
        latestVersion: "0.0.3",
      };
    },
    update_settings_save: (args) => {
      settings = (args as { settings: UpdateSettings }).settings;
      status = { status: "idle", currentVersion: "0.0.2", channel: settings.channel };
      desktop.emit("update://checked", status);
      return settings;
    },
  });
  const view = await render(<UpdateSettingsSection />);
  try {
    const install = page.getByRole("button", { name: "安装并重启", exact: true });
    const check = page.getByRole("button", { name: "检查更新", exact: true });
    const beta = page.getByRole("button", { name: "beta", exact: true });
    await expect.element(install).toBeVisible();
    await check.click();
    await expect.element(install).toBeEnabled();
    await expect
      .element(page.getByRole("button", { name: "下载更新", exact: true }))
      .not.toBeInTheDocument();
    fail = true;
    await check.click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("offline");
    await expect.element(install).toBeEnabled();
    desktop.emit("update://checked", { ...status, status: "downloading" });
    await expect.element(check).toBeDisabled();
    await expect.element(beta).toBeDisabled();
    desktop.emit("update://download-finished", status);
    await expect.element(beta).toBeEnabled();
    await beta.click();
    await expect.element(beta).toHaveAttribute("aria-pressed", "true");
    await expect.element(install).not.toBeInTheDocument();
    expect(status.channel).toBe("beta");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
