import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { Launcher } from "./Launcher";
import type { LauncherItem, LauncherState } from "./types";

it("preloads without searching and cancels hidden queries before reopening", async () => {
  const previousUrl = window.location.href;
  window.history.replaceState(null, "", "?view=launcher&preload=1");
  let resolveQuery!: (value: unknown) => void;
  let querySession = "";
  const desktop = installDesktopBridge({
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [] }),
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_query: (value) => {
      querySession = (value as { sessionId: string }).sessionId;
      return new Promise((resolve) => {
        resolveQuery = resolve;
      });
    },
  });
  const view = await render(<Launcher />);
  try {
    await expect
      .poll(() => desktop.calls.some((call) => call.command === "launcher_state"))
      .toBe(true);
    expect(desktop.calls.some((call) => call.command === "launcher_query")).toBe(false);
    desktop.emit("launcher-visibility-changed", { visible: true });
    await expect.poll(() => querySession).not.toBe("");
    const previousSession = querySession;
    desktop.emit("launcher-visibility-changed", { visible: false });
    await expect
      .poll(() => desktop.calls.some((call) => call.command === "launcher_cancel_query"))
      .toBe(true);
    resolveQuery({
      sessionId: previousSession,
      items: [{ id: "stale", pluginId: "fixture", title: "隐藏后的旧结果" }],
    });
    desktop.emit("launcher-visibility-changed", { visible: true });
    await expect.poll(() => querySession).not.toBe(previousSession);
    await expect.element(page.getByText("隐藏后的旧结果", { exact: true })).not.toBeInTheDocument();
    expect(desktop.calls.filter((call) => call.command === "launcher_state")).toHaveLength(1);
  } finally {
    resolveQuery?.({ sessionId: querySession, items: [] });
    await view.unmount();
    desktop.restore();
    window.history.replaceState(null, "", previousUrl);
  }
});

// A shortcut's empty selection used to invalidate the pending empty query
// without changing any effect dependency, leaving the loading status forever.
it("restarts an unchanged shortcut query and ignores its superseded response", async () => {
  const requests: Array<{ sessionId: string; resolve: (value: unknown) => void }> = [];
  const desktop = installDesktopBridge({
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [] }),
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_query: (args) =>
      new Promise((resolve) => {
        requests.push({ sessionId: (args as { sessionId: string }).sessionId, resolve });
      }),
  });
  const view = await render(<Launcher />);
  const handoff = { kind: "launcher-input", result: { text: "", revision: 1 } };
  try {
    await expect.poll(() => requests.length).toBe(1);
    desktop.emit("open-workspace", handoff);
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].sessionId).not.toBe(requests[0].sessionId);
    await expect
      .poll(() =>
        desktop.calls.some(
          (call) =>
            call.command === "launcher_cancel_query" &&
            (call.args as { sessionId: string }).sessionId === requests[0].sessionId,
        ),
      )
      .toBe(true);
    requests[0].resolve({
      sessionId: requests[0].sessionId,
      requestId: "old",
      revision: 0,
      items: [{ id: "old", pluginId: "fixture", title: "过期查询结果" }],
    });
    requests[1].resolve({
      sessionId: requests[1].sessionId,
      requestId: "new",
      revision: 0,
      items: [{ id: "new", pluginId: "fixture", title: "当前查询结果" }],
    });
    await expect.element(page.getByText("当前查询结果", { exact: true })).toBeVisible();
    await expect.element(page.getByText("过期查询结果", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByTestId("launcher-query-status")).not.toBeInTheDocument();
    desktop.emit("open-workspace", handoff);
    await expect
      .poll(() => desktop.calls.filter((call) => call.command === "launcher_take_workspace").length)
      .toBe(3);
    expect(requests).toHaveLength(2);
    await expect.element(page.getByText("当前查询结果", { exact: true })).toBeVisible();
  } finally {
    for (const request of requests) request.resolve({ sessionId: request.sessionId, items: [] });
    await view.unmount();
    desktop.restore();
  }
});

it("fills the shared launcher with a selection and ignores stale handoffs after the user edits it", async () => {
  type Handoff = { kind: string; result: { text: string; revision: number } };
  let resolveInitial!: (value: Handoff) => void;
  const initial = new Promise<Handoff>((resolve) => {
    resolveInitial = resolve;
  });
  let reads = 0;
  const desktop = installDesktopBridge({
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [] }),
    launcher_take_workspace: () => (++reads === 1 ? initial : undefined),
    launcher_cancel_query: () => undefined,
    launcher_query: (value) => ({
      sessionId: (value as { sessionId: string }).sessionId,
      requestId: "selection",
      revision: 0,
      items: [],
    }),
  });
  const view = await render(<Launcher />);
  const handoff = (text: string, revision: number): Handoff => ({
    kind: "launcher-input",
    result: { text, revision },
  });
  try {
    await expect.poll(() => reads).toBe(1);
    const search = page.getByRole("combobox", { name: "搜索应用、插件与操作" });
    desktop.emit("open-workspace", handoff("这是选中的一句话", 2));
    await expect.element(search).toHaveValue("这是选中的一句话");
    await expect
      .poll(() =>
        desktop.calls.some(
          (call) =>
            call.command === "launcher_query" &&
            (call.args as { query?: string }).query === "这是选中的一句话",
        ),
      )
      .toBe(true);
    resolveInitial(handoff("旧窗口启动时的选区", 1));
    await search.fill("用户修改的文字");
    desktop.emit("open-workspace", handoff("这是选中的一句话", 2));
    await expect.poll(() => reads).toBe(3);
    await expect.element(search).toHaveValue("用户修改的文字");
    desktop.emit("open-workspace", handoff("", 3));
    await expect.element(search).toHaveValue("");
  } finally {
    resolveInitial(handoff("", 1));
    await view.unmount();
    desktop.restore();
  }
});

it("shows one loading status until all query groups finish", async () => {
  let sessionId = "";
  const desktop = installDesktopBridge({
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [] }),
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_query: (value) => {
      sessionId = (value as { sessionId: string }).sessionId;
      return {
        sessionId,
        requestId: "stream",
        revision: 0,
        pending: true,
        items: [],
        groups: [
          { id: "commands", title: "操作", status: "pending", items: [] },
          {
            id: "applications",
            title: "应用",
            status: "pending",
            items: [],
            hint: "输入英文单词、词形或短语；本地查词不联网。",
          },
        ],
      };
    },
  });
  const view = await render(<Launcher />);
  try {
    await expect.element(page.getByTestId("launcher-query-status")).toBeVisible();
    await expect.poll(() => sessionId).not.toBe("");
    expect(page.getByTestId("launcher-query-status").elements()).toHaveLength(1);
    desktop.emit("launcher-query-updated", {
      sessionId,
      requestId: "stream",
      revision: 1,
      pending: false,
      items: [],
      groups: [
        {
          id: "commands",
          title: "操作",
          status: "ready",
          items: [],
          hint: "输入英文单词、词形或短语；本地查词不联网。",
        },
      ],
    });
    await expect.element(page.getByTestId("launcher-query-status")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("输入英文单词、词形或短语；本地查词不联网。", { exact: true }))
      .toBeVisible();
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("searches, navigates real candidates in both directions and executes the selected entry", async () => {
  const items: LauncherItem[] = [
    {
      id: "owned-search-a",
      pluginId: "spark233.notes",
      commandId: "open",
      kind: "command",
      title: "测试入口甲",
      actions: [{ id: "owned-extra-action", title: "附加操作", commandId: "extra" }],
    },
    {
      id: "owned-search-b",
      pluginId: "spark233.clipboard",
      commandId: "history",
      kind: "command",
      title: "测试入口乙",
    },
    {
      id: "owned-application",
      pluginId: "fixture.tools",
      kind: "application",
      commandId: "app",
      title: "匹配应用完整样本",
    },
    {
      id: "owned-next-row",
      pluginId: "fixture.next-row",
      kind: "command",
      commandId: "next-row",
      title: "下一行入口",
    },
    {
      id: "owned-new-note",
      pluginId: "spark233.notes",
      commandId: "new",
      kind: "command",
      title: "新建便签",
    },
    {
      id: "owned-applications-entry",
      pluginId: "spark233.applications",
      commandId: "search",
      kind: "command",
      title: "搜索应用入口样本",
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
    ...Array.from({ length: 20 }, (_, index): LauncherItem => ({
      id: `owned-operation-${index}`,
      pluginId: "spark233.notes",
      commandId: `operation-${index}`,
      kind: "command",
      title: `附加操作 ${index + 1}`,
    })),
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
      launcher: {
        role: ["owned-search-a", "owned-search-b", "owned-next-row"].includes(item.id)
          ? "entry"
          : item.id === "owned-applications-entry"
            ? "keyword-only"
            : "action",
      },
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
        groups:
          query === "查找"
            ? [
                {
                  id: "commands",
                  title: "操作",
                  status: "ready",
                  items: items.filter((item) => item.kind !== "application"),
                },
                {
                  id: "application-provider",
                  pluginId: "spark233.applications",
                  title: "搜索应用",
                  status: "ready",
                  instructions: "支持应用原名、中文全拼、拼音首字母与中英混排。",
                  items: items.filter((item) => item.kind === "application"),
                },
              ]
            : [],
      };
    },
    launcher_execute: () => undefined,
    settings_open: () => undefined,
  });
  const view = await render(
    <div style={{ width: 320 }}>
      <Launcher />
    </div>,
  );
  try {
    const search = page.getByRole("combobox", { name: "搜索应用、插件与操作" });
    await search.fill("查找");
    const first = page.getByRole("option", { name: "测试入口甲", exact: false });
    const second = page.getByRole("option", { name: "测试入口乙", exact: false });
    await expect.element(first).toBeVisible();
    await expect.element(second).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: "匹配应用完整样本", exact: false }))
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
    const newNote = page.getByRole("option", { name: "新建便签", exact: false });
    await expect.element(file).toBeVisible();
    await expect.element(dictionary).toBeVisible();
    const firstBox = first.element().getBoundingClientRect();
    const secondBox = second.element().getBoundingClientRect();
    expect(Math.abs(firstBox.top - secondBox.top)).toBeLessThan(1);
    expect(secondBox.left).toBeGreaterThan(firstBox.left);
    const nextRow = page.getByRole("option", { name: "下一行入口", exact: false });
    await expect.element(nextRow).toBeVisible();
    const nextRowBox = nextRow.element().getBoundingClientRect();
    expect(nextRowBox.top).toBeGreaterThanOrEqual(firstBox.bottom);
    expect(Math.abs(nextRowBox.left - firstBox.left)).toBeLessThan(1);
    expect(firstBox.width).toBeLessThan(112);
    expect(firstBox.height).toBeLessThan(112);
    const grid = first.element().closest('[data-query-group="applications"]')!;
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
    expect(grid.scrollHeight).toBeLessThanOrEqual(grid.clientHeight);
    const applicationName = page
      .getByRole("option", { name: "匹配应用完整样本", exact: false })
      .element()
      .querySelector("div > span")!;
    const nameLines = document.createRange();
    nameLines.selectNodeContents(applicationName);
    expect(nameLines.getClientRects()).toHaveLength(2);
    expect(applicationName.textContent).toBe("匹配应用完整样本");
    await expect
      .element(page.getByRole("option", { name: "搜索应用", exact: true }))
      .not.toBeInTheDocument();
    const keywordOnly = page.getByRole("option", { name: /^搜索应用入口样本/ });
    await expect.element(keywordOnly).toBeVisible();
    expect(keywordOnly.element().closest('[data-query-group="applications"]')).toBeNull();
    expect(file.element().getBoundingClientRect().top).toBeGreaterThan(firstBox.bottom);
    expect(newNote.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(nextRowBox.bottom);
    expect(file.element().getBoundingClientRect().top).toBeGreaterThan(
      newNote.element().getBoundingClientRect().top,
    );
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
    await expect.element(nextRow).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(first).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    expect(desktop.calls.filter((call) => call.command === "launcher_execute")).toEqual([]);
    await first.click({ button: "right" });
    await expect.element(page.getByRole("menuitem", { name: "附加操作" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menuitem", { name: "附加操作" })).not.toBeInTheDocument();
    second.element().focus();
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    // Long operation lists used to grow inside cmdk's unbounded sizing wrapper
    // and get clipped instead of scrolling independently of the icon grid.
    const operations = newNote.element().closest("[aria-label]")!;
    expect(operations.clientHeight).toBeGreaterThan(0);
    expect(operations.scrollHeight).toBeGreaterThan(operations.clientHeight);
    await userEvent.keyboard("{End}");
    const lastOperation = page.getByRole("option", { name: "附加操作 20", exact: false });
    await expect.element(lastOperation).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => operations.scrollTop).toBeGreaterThan(0);
    const lastOperationBox = lastOperation.element().getBoundingClientRect();
    const operationsBox = operations.getBoundingClientRect();
    expect(lastOperationBox.bottom).toBeLessThanOrEqual(operationsBox.bottom + 1);
    expect(lastOperationBox.top).toBeGreaterThanOrEqual(operationsBox.top);
    expect(first.element().getBoundingClientRect().top).toBeCloseTo(firstBox.top, 0);
    lastOperation.element().focus();
    second.element().focus();
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/launcher-plugin-grid.png",
    });
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() =>
        desktop.calls
          .filter((call) => call.command === "launcher_execute")
          .map((call) => call.args),
      )
      .toEqual([{ id: "owned-search-b", pluginId: "spark233.clipboard", commandId: "history" }]);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("keeps incremental results after execution and reaches the end of a scrolling application grid", async () => {
  const applications: LauncherItem[] = Array.from({ length: 80 }, (_, index) => ({
    id: `scroll-app-${index}`,
    pluginId: "fixture.applications",
    commandId: `app-${index}`,
    kind: "application",
    title: `滚动应用 ${index + 1}`,
    actions: [{ id: `inspect-${index}`, title: "检查应用", commandId: "inspect" }],
  }));
  let sessionId = "";
  const desktop = installDesktopBridge({
    launcher_state: () => ({ firstRun: false, pluginsReady: true, commands: [] }),
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_query: (args) => {
      sessionId = (args as { sessionId: string }).sessionId;
      return {
        sessionId,
        requestId: "stream",
        revision: 0,
        pending: true,
        items: applications,
        groups: [
          { id: "apps", title: "应用", status: "ready", items: applications },
          { id: "late", title: "稍后结果", status: "pending", items: [] },
        ],
      };
    },
    launcher_execute: () => undefined,
  });
  const view = await render(
    <div style={{ width: 320 }}>
      <Launcher />
    </div>,
  );
  try {
    const first = page.getByRole("option", { name: "滚动应用 1", exact: true });
    await expect.element(first).toBeVisible();
    // Execute the extra action without closing the launcher, then deliver a
    // provider update belonging to the same query session.
    await first.click({ button: "right" });
    await page.getByRole("menuitem", { name: "检查应用", exact: true }).click();
    await expect
      .poll(() => desktop.calls.some((call) => call.command === "launcher_execute"))
      .toBe(true);
    const late: LauncherItem = {
      id: "late",
      pluginId: "fixture.late",
      commandId: "late",
      title: "增量结果已到达",
    };
    desktop.emit("launcher-query-updated", {
      sessionId,
      requestId: "stream",
      revision: 1,
      pending: false,
      items: [...applications, late],
      groups: [
        { id: "apps", title: "应用", status: "ready", items: applications },
        { id: "late", title: "稍后结果", status: "ready", items: [late] },
      ],
    });
    await expect
      .element(page.getByRole("option", { name: "增量结果已到达", exact: false }))
      .toBeVisible();
    const grid = first.element().closest('[data-query-group="applications"]')!;
    expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);
    (first.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}".repeat(79));
    const last = page.getByRole("option", { name: "滚动应用 80", exact: true });
    await expect.element(last).toHaveAttribute("aria-selected", "true");
    await expect.element(last).toHaveFocus();
    expect(grid.scrollTop).toBeGreaterThan(0);
    const itemRect = last.element().getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    expect(itemRect.top).toBeGreaterThanOrEqual(gridRect.top - 1);
    expect(itemRect.bottom).toBeLessThanOrEqual(gridRect.bottom + 1);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
