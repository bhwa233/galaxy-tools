import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SettingsWindow } from "./SettingsWindow";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";

it("keeps shortcut drafts on registration failure, identifies conflicts and persists tray visibility and order", async () => {
  const previousUrl = location.href;
  history.replaceState(null, "", "?view=settings&page=shortcuts");
  let fail = true;
  let config = {
    theme: "system",
    locale: "zh-CN",
    dataDir: "/fixture",
    globalShortcut: "Alt+Space",
    toggleVisibilityShortcut: "",
    commandShortcuts: { "fixture.plugin:open": "Ctrl+K" },
    trayMenu: { hidden: [] as string[], order: [] as string[] },
  };
  const desktop = installDesktopBridge({
    config_get: () => config,
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [], preferences: [] }),
    plugins_list: () => ({
      plugins: [
        {
          pluginId: "fixture.plugin",
          displayName: "测试插件",
          enabled: true,
          status: "enabled",
          version: "1.0.0",
          commands: [
            { id: "open", title: "打开测试功能" },
            { id: "pause", title: "暂停记录" },
          ],
          tray: [
            { id: "open", commandId: "open" },
            { id: "pause", commandId: "pause" },
          ],
        },
      ],
      catalog: [],
      pending: [],
      updates: [],
      tasks: [],
      checking: false,
    }),
    start_shortcut_recording: () => {},
    stop_shortcut_recording: () => {},
    global_shortcut_check: () => ({ available: true, conflictType: "none", message: "" }),
    config_patch: (args) => {
      if (fail) throw new Error("Shortcut registration failed");
      const { patch } = args as { patch: Partial<typeof config> };
      config = {
        ...config,
        ...patch,
        commandShortcuts: { ...config.commandShortcuts, ...patch.commandShortcuts },
      };
      desktop.emit("config-changed", config);
      return config;
    },
  });
  const view = await render(<SettingsWindow />);
  const record = async (key: string, ctrl: boolean, alt: boolean) => {
    const previous = desktop.calls.filter(
      (call) => call.command === "start_shortcut_recording",
    ).length;
    await page.getByRole("button", { name: "测试插件 · 打开测试功能", exact: true }).click();
    await expect
      .poll(
        () => desktop.calls.filter((call) => call.command === "start_shortcut_recording").length,
      )
      .toBe(previous + 1);
    desktop.emit("shortcut-hook-key", { key, ctrl, alt, shift: false, meta: false });
  };
  try {
    await page.getByRole("button", { name: /^测试插件 已设置/ }).click();
    await expect
      .element(page.getByRole("button", { name: "测试插件 · 打开测试功能", exact: true }))
      .toBeVisible();
    await record("Space", false, true);
    const recorderRow = page
      .getByRole("button", { name: "测试插件 · 打开测试功能", exact: true })
      .element()
      .closest("section");
    expect(recorderRow?.querySelector('[role="status"]')?.textContent?.trim()).toBeTruthy();
    await expect
      .element(page.getByRole("button", { name: "保存更改", exact: true }))
      .toBeDisabled();
    await record("J", true, true);
    await expect.element(page.getByRole("button", { name: "保存更改", exact: true })).toBeEnabled();
    expect(desktop.calls.some((call) => call.command === "config_patch")).toBe(false);
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect
      .element(page.getByText("Shortcut registration failed", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "托盘菜单", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect
      .element(
        page
          .getByRole("button", { name: "测试插件 · 打开测试功能", exact: true })
          .getByText("Ctrl+Alt+J", { exact: true }),
      )
      .toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.element(page.getByTestId("shortcut-save-status")).toBeVisible();
    expect(config.commandShortcuts["fixture.plugin:open"]).toBe("Ctrl+Alt+J");
    const saved = desktop.calls.filter((call) => call.command === "config_patch").at(-1)!;
    expect(saved.args).toMatchObject({
      patch: { commandShortcuts: { "fixture.plugin:open": "Ctrl+Alt+J" } },
      expectedCommandShortcuts: { "fixture.plugin:open": "Ctrl+K" },
    });
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/shortcut-management.png",
    });
    await page.getByRole("button", { name: "托盘菜单", exact: true }).click();
    await page.getByRole("checkbox", { name: "显示 打开测试功能", exact: true }).click();
    await expect.poll(() => config.trayMenu.hidden).toEqual(["fixture.plugin:open"]);
    await page.getByRole("button", { name: "上移 暂停记录", exact: true }).click();
    await expect
      .poll(() => config.trayMenu.order)
      .toEqual(["fixture.plugin:pause", "fixture.plugin:open"]);
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/tray-management.png",
    });
  } finally {
    await view.unmount();
    desktop.restore();
    history.replaceState(null, "", previousUrl);
  }
});
