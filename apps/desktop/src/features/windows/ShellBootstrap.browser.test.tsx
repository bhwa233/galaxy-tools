import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { mountDesktopApp } from "../../platform/mount";
import { DesktopWindow } from "./DesktopWindow";
import { SettingsWindow } from "../settings/SettingsWindow";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";

// The original blank screen waited for config_get before mounting React. Use
// the real mount and settings page, with that IPC deliberately left pending.
it("shows close controls before config arrives and recovers a timed-out read by retry", async () => {
  const target = document.createElement("div");
  target.id = "root";
  document.body.append(target);
  let stalled = true;
  const desktop = installDesktopBridge({
    config_get: () =>
      stalled
        ? new Promise(() => {})
        : { theme: "system", accentColor: "green", locale: "zh-CN", dataDir: "/fixture" },
    desktop_ready: () => undefined,
    launcher_state: () => ({ firstRun: false, pluginsReady: false, commands: [] }),
    window_control: () => undefined,
    update_status: () => ({ status: "idle", currentVersion: "0.1.7", channel: "stable" }),
    update_settings_get: () => ({
      autoCheck: false,
      autoDownload: false,
      checkIntervalHours: 24,
      channel: "stable",
      allowPrerelease: false,
      hasMirrorChyanCdk: false,
    }),
  });
  const root = await mountDesktopApp(() => (
    <DesktopWindow>
      <SettingsWindow />
    </DesktopWindow>
  ));
  try {
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    expect(desktop.calls.some((call) => call.command === "window_control")).toBe(true);
    await expect
      .element(page.getByText("读取配置超时，请重试。窗口仍可关闭。", { exact: true }), {
        timeout: 8000,
      })
      .toBeVisible();
    stalled = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "紫", exact: true })).toBeVisible();
  } finally {
    root.unmount();
    target.remove();
    desktop.restore();
  }
}, 15000);

it("keeps retry and native close available when a host page throws during render", async () => {
  const target = document.createElement("div");
  target.id = "root";
  document.body.append(target);
  const desktop = installDesktopBridge({
    desktop_ready: () => undefined,
    window_control: () => undefined,
  });
  const FailedPage = () => {
    throw new Error("fixture page failed");
  };
  const root = await mountDesktopApp(FailedPage);
  try {
    await expect.element(page.getByText("页面加载失败", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    expect(desktop.calls.some((call) => call.command === "window_control")).toBe(true);
  } finally {
    root.unmount();
    target.remove();
    desktop.restore();
  }
});
