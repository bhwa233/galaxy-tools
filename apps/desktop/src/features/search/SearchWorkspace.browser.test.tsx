import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { SearchWorkspace } from "./SearchWorkspace";

const fileTime = (unixMs: number): string =>
  ((BigInt(unixMs) + 11_644_473_600_000n) * 10_000n).toString();

const sheet = {
  id: "row-1",
  title: "report.xlsx",
  description: "D:\\work\\report.xlsx",
  kind: "file",
  commandId: "open",
  parameters: { selection: "row-1", callerId: "search-workspace" },
  searchHit: {
    name: "report.xlsx",
    path: "D:\\work\\report.xlsx",
    directory: false,
    size: "1536",
    modified: fileTime(Date.UTC(2026, 0, 13, 2, 4)),
    extension: "xlsx",
  },
};

function workspace(
  status: { state: string; message?: string } = { state: "ok" },
  windowControl: (args: unknown) => unknown = () => false,
  historyAction: (args: unknown) => unknown = () => ({ recent: [], saved: [] }),
) {
  return installDesktopBridge({
    window_control: windowControl,
    search_action: (args) => {
      const action = (args as { action: string }).action;
      if (action === "query" || action === "next-page")
        return {
          items: status.state === "ok" ? [sheet] : [],
          searchPage: { total: 516, approximate: true, hasMore: false },
          searchStatus: status,
        };
      if (action === "install-service") return { items: [] };
      if (action === "open" || action === "reveal" || action === "copy-path") return undefined;
      throw new Error(`Unexpected search action: ${action}`);
    },
    search_workspace: historyAction,
    settings_open: () => undefined,
    clipboard_write: () => undefined,
  });
}

// A late initial window-state read must not overwrite a newer resize event;
// changing window state must also leave the active search and its results intact.
it("keeps the latest window state and search when using title bar controls", async () => {
  let resolveInitial!: (value: boolean) => void;
  let reads = 0;
  let maximized = false;
  let closed = 0;
  const desktop = workspace({ state: "ok" }, (args) => {
    const { action } = args as { action: string };
    if (action === "isMaximized") {
      if (++reads === 1)
        return new Promise<boolean>((resolve) => {
          resolveInitial = resolve;
        });
      return maximized;
    }
    if (action === "toggleMaximize") {
      maximized = !maximized;
      desktop.emit("window-resized");
    }
  });
  const view = await render(<SearchWorkspace initialQuery="report" onClose={() => closed++} />);
  try {
    await expect.poll(() => reads).toBe(1);
    await expect
      .element(page.getByRole("cell", { name: "report.xlsx", exact: true }))
      .toBeVisible();
    maximized = true;
    desktop.emit("window-resized");
    await expect.element(page.getByRole("button", { name: "还原", exact: true })).toBeVisible();
    resolveInitial(false);
    await expect.element(page.getByRole("button", { name: "还原", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "还原", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "最大化", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "最小化", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }))
      .toHaveValue("report");
    await expect
      .element(page.getByRole("cell", { name: "report.xlsx", exact: true }))
      .toBeVisible();
    expect(
      desktop.calls.some(
        (call) =>
          call.command === "window_control" &&
          (call.args as { action: string }).action === "startDrag",
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    expect(closed).toBe(1);
    expect(queries(desktop)).toHaveLength(1);
  } finally {
    resolveInitial?.(false);
    await view.unmount();
    desktop.restore();
  }
});

const queries = (desktop: ReturnType<typeof workspace>) =>
  desktop.calls
    .filter((call) => call.command === "search_action")
    .map(
      (call) =>
        call.args as {
          action: string;
          category?: string;
          sort?: string;
          sortDesc?: boolean;
          directory?: string;
          query?: string;
        },
    )
    .filter((args) => args.action === "query");

it("searches a launcher handoff as filenames even after a content search", async () => {
  window.localStorage.setItem("search.workspace.mode", "content");
  const desktop = workspace();
  const view = await render(<SearchWorkspace initialQuery="report" onClose={() => {}} />);
  try {
    await expect
      .poll(() => queries(desktop).at(-1))
      .toMatchObject({ query: "report", mode: "files" });
    await expect
      .element(page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }))
      .toHaveValue("report");
  } finally {
    await view.unmount();
    desktop.restore();
    window.localStorage.removeItem("search.workspace.mode");
  }
});

it("lists index rows with the workspace columns", async () => {
  const desktop = workspace();
  const view = await render(<SearchWorkspace onClose={() => {}} />);
  try {
    await expect.element(page.getByTestId("search-empty-prompt")).toBeVisible();
    await userEvent.fill(page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }), "report");
    await expect.element(page.getByText("report", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("cell", { name: "D:\\work" })).toBeVisible();
    await expect.element(page.getByRole("cell", { name: "Excel 工作表" })).toBeVisible();
    await expect.element(page.getByRole("cell", { name: "1.5 KB" })).toBeVisible();
    await expect
      .poll(() => page.getByTestId("search-result-count").element().textContent)
      .toContain("516");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("re-queries with a category token and a column sort", async () => {
  const desktop = workspace();
  const view = await render(<SearchWorkspace onClose={() => {}} />);
  try {
    await userEvent.fill(page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }), "report");
    await expect
      .poll(() => page.getByTestId("search-result-count").element().textContent)
      .toContain("516");

    await page.getByRole("button", { name: "Excel" }).click();
    await expect
      .element(page.getByRole("button", { name: "Excel" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(queries(desktop).at(-1)).toMatchObject({ category: "excel", query: "report" });

    await page.getByRole("button", { name: "修改日期" }).click();
    expect(queries(desktop).at(-1)).toMatchObject({ sort: "mtime", sortDesc: true });
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("offers the service installation when the index is missing", async () => {
  const desktop = workspace({ state: "service-not-installed", message: "install it" });
  const view = await render(<SearchWorkspace onClose={() => {}} />);
  try {
    await userEvent.fill(page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }), "report");
    await expect.element(page.getByTestId("search-empty-service")).toBeVisible();
    await page.getByRole("button", { name: "安装服务" }).click();
    expect(
      desktop.calls.some(
        (call) => (call.args as { action?: string } | undefined)?.action === "install-service",
      ),
    ).toBe(true);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("reuses saved directory conditions by running a fresh query", async () => {
  let saved: unknown[] = [];
  const desktop = workspace(
    { state: "ok" },
    () => false,
    (args) => {
      const request = args as { action: string; conditions: unknown };
      if (request.action === "pick-directory") return { recent: [], saved, directory: "D:/work" };
      if (request.action === "save")
        saved = [
          {
            ...(request.conditions as object),
            id: "01234567-1234-4234-8234-012345678901",
            name: "report",
            at: "2026-10-30T00:00:00Z",
          },
        ];
      return { recent: [], saved };
    },
  );
  const view = await render(<SearchWorkspace initialQuery="report" onClose={() => {}} />);
  try {
    await page.getByRole("button", { name: "限定目录", exact: true }).click();
    await expect.poll(() => queries(desktop).at(-1)?.directory).toBe("D:/work");
    await page.getByRole("button", { name: "保存当前条件", exact: true }).click();
    await page.getByRole("button", { name: "恢复默认范围", exact: true }).click();
    await page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }).fill("another");
    await expect.poll(() => queries(desktop).at(-1)?.query).toBe("another");
    await page.getByRole("button", { name: "最近与常用搜索", exact: true }).click();
    await page.getByRole("button", { name: /^report/ }).click();
    await expect
      .poll(() => queries(desktop).at(-1))
      .toMatchObject({ query: "report", directory: "D:/work" });
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/functional-search.png",
    });
    await expect
      .element(page.getByRole("textbox", { name: "按文件名、路径或拼音搜索" }))
      .toHaveValue("report");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
