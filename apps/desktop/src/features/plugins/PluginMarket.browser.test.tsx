import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { PluginManagementDialog } from "./PluginManagementDialog";
import type { PluginManagementState } from "./types";
import type { UToolsCatalogPage, UToolsCatalogRequest } from "../../../shared/plugin-market";

it("loads uTools on demand, resets pagination on sort, ignores stale replies and remembers source orders", async () => {
  const key = "spark233.plugin-market.preferences.v1",
    saved = localStorage.getItem(key);
  localStorage.removeItem(key);
  const state: PluginManagementState = {
    plugins: [],
    catalog: [],
    pending: [],
    updates: [],
    tasks: [],
    checking: false,
  };
  const requests: UToolsCatalogRequest[] = [];
  let oldReply: ((result: UToolsCatalogPage) => void) | undefined;
  const result = (name: string, index = 1): UToolsCatalogPage => ({
    items: [
      {
        pluginId: "fixture-catalog",
        displayName: name,
        author: "Catalog author",
        rating: 4.8,
        voters: 50,
        pageURL: "https://www.u-tools.cn/plugins/detail/" + encodeURIComponent(name) + "/",
      },
    ],
    total: 40,
    page: index,
    pageSize: 20,
    fetchedAt: Date.now(),
    stale: false,
  });
  const desktop = installDesktopBridge({
    plugins_list: () => state,
    plugins_prepare_utools: () => undefined,
    plugins_utools_catalog: (args) => {
      const input = args as UToolsCatalogRequest;
      requests.push(input);
      if (input.sort === "rating" && !input.query && !oldReply)
        return new Promise<UToolsCatalogPage>((resolve) => {
          oldReply = resolve;
        });
      return result(input.query ? "新查询结果" : "目录插件", input.page);
    },
    shell_open: () => {},
  });
  let view = await render(<PluginManagementDialog embedded open onOpenChange={() => {}} />);
  try {
    await expect.element(page.getByRole("button", { name: "uTools", exact: true })).toBeVisible();
    expect(requests).toEqual([]);
    await page.getByRole("button", { name: "uTools", exact: true }).click();
    await expect
      .element(page.getByRole("listitem", { name: "目录插件", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect.poll(() => requests.at(-1)?.page).toBe(2);
    await expect.element(page.getByRole("button", { name: "上一页", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "插件排序", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "评分最高", exact: true }).click();
    await expect.poll(() => oldReply).toBeTruthy();
    expect(requests.at(-1)).toMatchObject({ page: 1, sort: "rating" });
    await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill("new");
    await expect
      .element(page.getByRole("listitem", { name: "新查询结果", exact: true }))
      .toBeVisible();
    expect(requests.at(-1)).toMatchObject({ query: "new", page: 1, sort: "rating" });
    oldReply!(result("过期结果"));
    await expect.element(page.getByText("过期结果", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "官方详情", exact: true }).click();
    expect(desktop.calls.find((call) => call.command === "shell_open")?.args).toEqual({
      url: "https://www.u-tools.cn/plugins/detail/" + encodeURIComponent("新查询结果") + "/",
    });
    await view.unmount();
    view = await render(<PluginManagementDialog embedded open onOpenChange={() => {}} />);
    await expect
      .poll(() => page.getByRole("button", { name: "插件排序", exact: true }).element().textContent)
      .toContain("评分最高");
    await page.getByRole("button", { name: "spark233", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "插件排序", exact: true }).element().textContent)
      .toContain("名称 A→Z");
    await page.getByRole("button", { name: "uTools", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "下载并检查", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "下载并检查", exact: true }).click();
    await expect
      .poll(() => desktop.calls.find((call) => call.command === "plugins_prepare_utools")?.args)
      .toEqual({ catalogId: "fixture-catalog" });
  } finally {
    await view.unmount();
    desktop.restore();
    if (saved === null) localStorage.removeItem(key);
    else localStorage.setItem(key, saved);
  }
});

it("keeps base versions visible and refreshes release notes when a development build changes", async () => {
  const development = {
    buildId: "dev-20261112-a",
    builtAt: "2026-11-12T03:04:05.000Z",
    commit: "1234567890abcdef",
  };
  const plugin = {
    pluginId: "fixture.development",
    packageName: "@fixture/development",
    displayName: "开发构建插件",
    version: "0.1.6",
    development,
    enabled: true,
    status: "idle",
    source: { kind: "directory" as const, location: "C:/fixtures/development" },
    capabilities: [],
    commands: [],
    dependencies: {},
    optionalDependencies: {},
  };
  let state: PluginManagementState = {
    plugins: [
      plugin,
      {
        ...plugin,
        pluginId: "fixture.release",
        packageName: "@fixture/release",
        displayName: "正式发布插件",
        development: undefined,
      },
    ],
    catalog: [
      {
        ...plugin,
        installedVersion: plugin.version,
        installedDevelopment: development,
        pending: false,
        canPrepare: true,
      },
      {
        ...plugin,
        pluginId: "fixture.release",
        packageName: "@fixture/release",
        displayName: "正式发布插件",
        development: undefined,
        installedVersion: plugin.version,
        pending: false,
        canPrepare: false,
      },
    ],
    pending: [],
    updates: [],
    tasks: [],
    checking: false,
  };
  const desktop = installDesktopBridge({
    plugins_list: () => state,
    plugins_release_notes: () => ({
      status: "available",
      content: `Release notes for ${state.plugins[0]!.development!.buildId}`,
    }),
  });
  const view = await render(<PluginManagementDialog embedded open onOpenChange={() => {}} />);
  try {
    const catalog = page.getByRole("listitem", { name: "开发构建插件", exact: true });
    await expect.element(catalog).toBeVisible();
    expect(catalog.element().textContent).toContain("0.1.6");
    expect(catalog.element().textContent).toContain("开发版");
    expect(
      page.getByRole("listitem", { name: "正式发布插件", exact: true }).element().textContent,
    ).not.toContain("开发版");
    await page.getByRole("button", { name: "已安装", exact: true }).first().click();
    await expect.element(page.getByText(development.buildId, { exact: true })).toBeVisible();
    const devCard = page
      .getByText(development.buildId, { exact: true })
      .element()
      .closest('[data-slot="card"]')!;
    const releaseCard = page
      .getByText("@fixture/release ·", { exact: true })
      .element()
      .closest('[data-slot="card"]')!;
    expect(devCard.querySelector("time")?.dateTime).toBe(development.builtAt);
    expect(devCard.querySelector("time")?.textContent).toContain("UTC");
    expect(devCard.textContent).toContain("1234567890ab");
    expect(releaseCard.querySelector("time")).toBeNull();
    expect(releaseCard.textContent).not.toContain("开发版");
    const notes = devCard.querySelector("summary")!;
    notes.click();
    await expect
      .element(page.getByText(`Release notes for ${development.buildId}`, { exact: true }))
      .toBeVisible();
    state = {
      ...state,
      plugins: [
        { ...plugin, development: { ...development, buildId: "dev-20261112-b" } },
        state.plugins[1]!,
      ],
    };
    desktop.emit("plugins-changed");
    await expect.element(page.getByText("dev-20261112-b", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(`Release notes for ${development.buildId}`, { exact: true }))
      .not.toBeInTheDocument();
    notes.click();
    notes.click();
    await expect
      .element(page.getByText("Release notes for dev-20261112-b", { exact: true }))
      .toBeVisible();
    expect(devCard.textContent).toContain("0.1.6");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
