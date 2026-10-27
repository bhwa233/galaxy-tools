import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { Launcher } from "./Launcher";
import type { LauncherItem, LauncherState } from "./types";

it("searches, navigates real candidates in both directions and executes the selected entry", async () => {
  const items: LauncherItem[] = [
    {
      id: "owned-search-a",
      pluginId: "spark233.notes",
      commandId: "open-a",
      kind: "command",
      title: "测试入口甲",
    },
    {
      id: "owned-search-b",
      pluginId: "spark233.clipboard",
      commandId: "open-b",
      kind: "command",
      title: "测试入口乙",
    },
    {
      id: "owned-application",
      pluginId: "fixture.tools",
      kind: "application",
      commandId: "app",
      title: "匹配应用样本",
    },
    {
      id: "owned-document",
      pluginId: "fixture.tools",
      commandId: "open-file",
      kind: "document",
      title: "文件信息样本",
      description: "isolated/readme.md",
    },
    {
      id: "owned-dictionary",
      pluginId: "fixture.tools",
      commandId: "word",
      kind: "dictionary",
      title: "词典释义样本",
      description: "本地词典信息",
    },
  ];
  const state: LauncherState = {
    firstRun: false,
    pluginsReady: true,
    commands: items.map((item) => ({
      id: item.commandId!,
      pluginId: item.pluginId,
      title: item.title,
      keywords: [],
      enabled: true,
    })),
  };
  const desktop = installDesktopBridge({
    launcher_state: () => state,
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_query: (value) => {
      const { query, sessionId } = value as { query: string; sessionId: string };
      return {
        sessionId,
        requestId: `owned-${sessionId}`,
        revision: 0,
        items: query === "查找" ? items : [],
      };
    },
    launcher_execute: () => undefined,
    settings_open: () => undefined,
  });
  const view = await render(<Launcher />);
  try {
    const search = page.getByRole("combobox", { name: "搜索命令与插件" });
    await search.fill("查找");
    const first = page.getByRole("option", { name: "测试入口甲", exact: false });
    const second = page.getByRole("option", { name: "测试入口乙", exact: false });
    await expect.element(first).toBeVisible();
    await expect.element(second).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: "匹配应用样本", exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "入口管理", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(first).toHaveAttribute("aria-selected", "true");
    expect(
      desktop.calls.some(
        (call) =>
          call.command === "launcher_query" && (call.args as { query?: string })?.query === "查找",
      ),
    ).toBe(true);

    const file = page.getByRole("option", { name: "文件信息样本", exact: false });
    const dictionary = page.getByRole("option", { name: "词典释义样本", exact: false });
    await expect.element(file).toBeVisible();
    await expect.element(dictionary).toBeVisible();
    const firstBox = first.element().getBoundingClientRect();
    const secondBox = second.element().getBoundingClientRect();
    expect(Math.abs(firstBox.top - secondBox.top)).toBeLessThan(1);
    expect(secondBox.left).toBeGreaterThan(firstBox.left);
    expect(file.element().getBoundingClientRect().top).toBeGreaterThan(firstBox.bottom);
    expect(dictionary.element().getBoundingClientRect().top).toBeGreaterThan(
      file.element().getBoundingClientRect().top,
    );
    expect(first.element().querySelector("svg")).not.toBeNull();
    expect(second.element().querySelector("svg")).not.toBeNull();
    await userEvent.keyboard("{Tab}");
    await expect.element(first).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(first).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(first).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    expect(desktop.calls.filter((call) => call.command === "launcher_execute")).toEqual([]);
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/launcher-plugin-row.png",
    });
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() =>
        desktop.calls
          .filter((call) => call.command === "launcher_execute")
          .map((call) => call.args),
      )
      .toEqual([{ id: "owned-search-b", pluginId: "spark233.clipboard", commandId: "open-b" }]);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
