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
