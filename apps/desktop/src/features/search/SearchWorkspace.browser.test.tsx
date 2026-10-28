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

function workspace(status: { state: string; message?: string } = { state: "ok" }) {
  return installDesktopBridge({
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
    settings_open: () => undefined,
    clipboard_write: () => undefined,
  });
}

const queries = (desktop: ReturnType<typeof workspace>) =>
  desktop.calls
    .filter((call) => call.command === "search_action")
    .map(
      (call) =>
        call.args as { action: string; category?: string; sort?: string; sortDesc?: boolean },
    )
    .filter((args) => args.action === "query");

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
