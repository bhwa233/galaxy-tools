import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SettingsWindow } from "./SettingsWindow";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";

it("fills the settings viewport and protects a plugin draft when changing settings categories", async () => {
  const oldUrl = location.href;
  history.replaceState(null, "", "?view=settings&page=plugins&pluginId=fixture.plugin");
  const desktop = installDesktopBridge({
    config_get: () => ({ theme: "system", locale: "zh-CN", dataDir: "/isolated-fixture" }),
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [], preferences: [] }),
    plugins_list: () => ({
      plugins: [
        {
          pluginId: "fixture.plugin",
          packageName: "fixture-plugin",
          displayName: "测试插件",
          version: "1.0.0",
          enabled: false,
          status: "disabled",
          source: { kind: "file", location: "isolated-fixture.tgz" },
          commands: [],
          capabilities: [],
          dependencies: {},
          optionalDependencies: {},
        },
      ],
      catalog: [],
      pending: [],
      updates: [],
      tasks: [],
      checking: false,
    }),
    plugin_settings_get: () => ({
      pluginId: "fixture.plugin",
      revision: "original",
      fields: [{ key: "model", type: "text", label: "translation.model" }],
      values: { model: "fixture-model" },
    }),
  });
  const view = await render(<SettingsWindow />);
  try {
    const input = page.getByRole("textbox", { name: "模型名" });
    await expect.element(input).toHaveValue("fixture-model");
    const rect = document.querySelector("main")!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(window.innerWidth - 1);
    expect(rect.height).toBeGreaterThanOrEqual(window.innerHeight - 1);
    await input.fill("local-draft");
    await page.getByRole("button", { name: "入口管理", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(input).toHaveValue("local-draft");
    expect(
      desktop.calls.filter(
        (call) => call.command === "plugin_settings_save" || call.command === "plugins_activate",
      ),
    ).toEqual([]);
    await page.screenshot({
      path: "../../../local-build/browser-ui/screenshots/settings-full-window.png",
    });
  } finally {
    await view.unmount();
    desktop.restore();
    history.replaceState(null, "", oldUrl);
  }
});
