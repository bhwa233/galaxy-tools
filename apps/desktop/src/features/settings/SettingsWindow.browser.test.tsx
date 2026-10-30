import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SettingsWindow } from "./SettingsWindow";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import type { InstallPreview, PluginManagementState } from "../plugins/types";

const plugin = {
  pluginId: "fixture.plugin",
  packageName: "fixture-plugin",
  displayName: "测试插件",
  version: "1.0.0",
  enabled: false,
  status: "disabled",
  source: { kind: "file" as const, location: "isolated-fixture.tgz" },
  commands: [],
  capabilities: [],
  dependencies: {},
  optionalDependencies: {},
};
const pluginState = (): PluginManagementState => ({
  plugins: [{ ...plugin }],
  catalog: [],
  pending: [],
  updates: [],
  tasks: [],
  checking: false,
});

it("keeps the latest accent choice while an earlier settings save is pending", async () => {
  const oldUrl = location.href;
  const oldAccent = document.documentElement.dataset.accent;
  const oldCache = localStorage.getItem("theme-accent");
  history.replaceState(null, "", "?view=settings&page=general");
  let config = {
    theme: "system",
    accentColor: "green",
    locale: "zh-CN",
    dataDir: "/isolated-fixture",
  };
  let finishFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let saves = 0;
  const desktop = installDesktopBridge({
    config_get: () => config,
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [], preferences: [] }),
    config_patch: async (args) => {
      if (++saves === 1) await first;
      config = { ...config, ...(args as { patch: typeof config }).patch };
      return config;
    },
  });
  const view = await render(<SettingsWindow />);
  try {
    await page.getByRole("button", { name: "紫", exact: true }).click();
    await expect.poll(() => saves).toBe(1);
    await page.getByRole("button", { name: "蓝", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "蓝", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.accent).toBe("blue");
    finishFirst!();
    await expect.poll(() => config.accentColor).toBe("blue");
    await expect
      .element(page.getByRole("button", { name: "蓝", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("theme-accent")).toBe("blue");
  } finally {
    finishFirst?.();
    await view.unmount();
    desktop.restore();
    history.replaceState(null, "", oldUrl);
    if (oldAccent === undefined) delete document.documentElement.dataset.accent;
    else document.documentElement.dataset.accent = oldAccent;
    if (oldCache === null) localStorage.removeItem("theme-accent");
    else localStorage.setItem("theme-accent", oldCache);
  }
});

it("fills the settings viewport and protects a plugin draft when changing settings categories", async () => {
  const oldUrl = location.href;
  history.replaceState(null, "", "?view=settings&page=plugins&pluginId=fixture.plugin");
  const desktop = installDesktopBridge({
    config_get: () => ({ theme: "system", locale: "zh-CN", dataDir: "/isolated-fixture" }),
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [], preferences: [] }),
    plugins_list: pluginState,
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
    await expect
      .element(page.getByRole("button", { name: "卸载", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "启用", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "插件市场", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(input).toHaveValue("local-draft");
    expect(
      desktop.calls.filter(
        (call) => call.command === "plugin_settings_save" || call.command === "plugins_activate",
      ),
    ).toEqual([]);
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/settings-full-window.png",
    });
    await page.getByRole("button", { name: "管理此插件", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "放弃更改", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "启用", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "配置此插件", exact: true }).click();
    await expect.element(input).toHaveValue("fixture-model");
  } finally {
    await view.unmount();
    desktop.restore();
    history.replaceState(null, "", oldUrl);
  }
});

it("discovers plugins in the marketplace and requires trust before confirming installation", async () => {
  const oldUrl = location.href;
  history.replaceState(null, "", "?view=settings&page=marketplace");
  const state = pluginState();
  state.catalog = [
    {
      pluginId: "fixture.new",
      packageName: "fixture-new",
      displayName: "可安装插件",
      version: "1.0.0",
      pending: false,
      canPrepare: true,
    },
  ];
  const desktop = installDesktopBridge({
    config_get: () => ({ theme: "system", locale: "zh-CN", dataDir: "/isolated-fixture" }),
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [], preferences: [] }),
    plugins_list: () => state,
    plugins_prepare_bundled: () => {
      state.pending = [
        {
          previewId: "owned-preview",
          metadata: {
            name: "fixture-new",
            version: "1.0.0",
            spark233: { displayName: "可安装插件", capabilities: ["node.backend"] },
          } as InstallPreview["metadata"],
          source: { kind: "file", location: "isolated-new.tgz" },
          integrity: "owned-integrity",
          requiresNativeTrust: true,
          createdAt: 0,
        },
      ];
      return state.pending[0];
    },
    plugins_confirm_install: () => {
      state.pending = [];
      return {};
    },
  });
  const view = await render(<SettingsWindow />);
  try {
    await expect.element(page.getByText("可安装插件", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "配置此插件", exact: true }))
      .not.toBeInTheDocument();
    expect(desktop.calls.some((call) => call.command === "plugin_settings_get")).toBe(false);
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/plugin-marketplace-discover.png",
    });
    await page.getByRole("button", { name: "准备安装", exact: true }).click();
    const confirm = page.getByRole("button", { name: "确认安装", exact: true });
    await expect.element(confirm).toBeVisible();
    await expect.element(confirm).toBeDisabled();
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/plugin-marketplace-confirm.png",
    });
    expect(desktop.calls.some((call) => call.command === "plugins_confirm_install")).toBe(false);
    await page.getByRole("checkbox").click();
    await confirm.click();
    expect(desktop.calls.find((call) => call.command === "plugins_confirm_install")?.args).toEqual({
      previewId: "owned-preview",
      trustNative: true,
    });
    await page.getByRole("button", { name: "已安装", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "配置此插件", exact: true }))
      .toBeVisible();
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/plugin-marketplace.png",
    });
  } finally {
    await view.unmount();
    desktop.restore();
    history.replaceState(null, "", oldUrl);
  }
});

it("manages enablement and keeps plugin data on uninstall unless explicitly selected", async () => {
  const oldUrl = location.href;
  history.replaceState(null, "", "?view=settings&page=marketplace&pluginId=fixture.plugin");
  const state = pluginState();
  const desktop = installDesktopBridge({
    config_get: () => ({ theme: "system", locale: "zh-CN", dataDir: "/isolated-fixture" }),
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [], preferences: [] }),
    plugins_list: () => state,
    plugins_enable: () => {
      state.plugins[0].enabled = true;
      state.plugins[0].status = "active";
      return {};
    },
    plugins_uninstall: () => {
      state.plugins = [];
      return {};
    },
  });
  const view = await render(<SettingsWindow />);
  try {
    await page.getByRole("button", { name: "启用", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "停用", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "卸载", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(desktop.calls.some((call) => call.command === "plugins_uninstall")).toBe(false);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认卸载", exact: true })
      .click();
    expect(desktop.calls.find((call) => call.command === "plugins_uninstall")?.args).toEqual({
      pluginId: "fixture.plugin",
      deleteData: false,
    });
  } finally {
    await view.unmount();
    desktop.restore();
    history.replaceState(null, "", oldUrl);
  }
});
