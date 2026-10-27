import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { Launcher } from "./Launcher";
import type { LauncherItem, LauncherState } from "./types";

it("enters a mode through its real candidate and Escape returns subsequent queries to ordinary search", async () => {
  const mode = "fixture.mode:catalog";
  const entry: LauncherItem = {
    id: "owned-mode-entry",
    pluginId: "fixture.mode",
    commandId: "search",
    kind: "command",
    title: "测试模式",
  };
  const state: LauncherState = {
    firstRun: false,
    pluginsReady: true,
    commands: [
      {
        id: "search",
        pluginId: entry.pluginId,
        title: entry.title,
        keywords: ["catalog"],
        enabled: true,
        mode,
      },
    ],
    modeOptions: { [mode]: { directoryFilter: false, placeholder: "在测试模式中查询" } },
  };
  const desktop = installDesktopBridge({
    launcher_state: () => state,
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_enter_mode: () => undefined,
    launcher_query: (value) => {
      const query = value as { query: string; sessionId: string; mode?: string };
      const items =
        query.mode === mode
          ? query.query === "模式内查询"
            ? [
                {
                  id: "owned-mode-result",
                  pluginId: entry.pluginId,
                  commandId: "open",
                  title: "模式内命中",
                },
              ]
            : []
          : query.query === "普通查询"
            ? [
                {
                  id: "owned-normal-result",
                  pluginId: entry.pluginId,
                  commandId: "open",
                  title: "普通查询命中",
                },
              ]
            : [entry];
      return {
        sessionId: query.sessionId,
        requestId: `owned-${query.sessionId}`,
        revision: 0,
        items,
      };
    },
  });
  const view = await render(<Launcher />);
  try {
    const entryOption = page.getByRole("option", { name: /^测试模式/ });
    await expect.element(entryOption).toBeVisible();
    const search = page.getByRole("combobox");
    await search.fill("catalog");
    await userEvent.keyboard("{Tab}");
    expect(desktop.calls.filter((call) => call.command === "launcher_enter_mode")).toEqual([]);
    await expect.element(search).toHaveAttribute("placeholder", "输入应用、插件或操作关键词…");
    await entryOption.click();
    await expect.element(search).toHaveAttribute("placeholder", "在测试模式中查询");
    await expect.element(page.getByRole("button", { name: "返回全部入口" })).toBeVisible();
    expect(
      desktop.calls
        .filter((call) => call.command === "launcher_enter_mode")
        .map((call) => call.args),
    ).toEqual([{ mode }]);
    await search.fill("模式内查询");
    await expect.element(page.getByRole("option", { name: /^模式内命中/ })).toBeVisible();
    expect(
      desktop.calls.filter((call) => call.command === "launcher_query").at(-1)?.args,
    ).toMatchObject({ mode, query: "模式内查询" });

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect
      .element(page.getByRole("button", { name: "返回全部入口" }))
      .not.toBeInTheDocument();
    await search.fill("普通查询");
    await expect.element(page.getByRole("option", { name: /^普通查询命中/ })).toBeVisible();
    const ordinary = desktop.calls.filter((call) => call.command === "launcher_query").at(-1)?.args;
    expect(ordinary).toMatchObject({ query: "普通查询" });
    expect(ordinary).not.toHaveProperty("mode");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
