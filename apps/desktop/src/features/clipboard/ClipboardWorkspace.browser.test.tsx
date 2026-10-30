import { act } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { invoke } from "../../platform/desktop";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { ClipboardWorkspace } from "./ClipboardWorkspace";
import type { ClipboardEntry, ClipboardPage, ClipboardRequest } from "./types";

it("ignores late searches and keeps original/plain-text copy bound to the current entry", async () => {
  const entry = (id: string): ClipboardEntry => ({
    id,
    kind: id === "latest result" ? "html" : "text",
    preview: id,
    text: `text ${id}`,
    files: [],
    source: "fixture",
    sourceTitle: "fixture",
    formats: ["text"],
    createdAt: Date.now(),
    lastUsedAt: 0,
    copies: 0,
    note: "",
    tags: [],
    pinned: false,
    favorite: false,
    favoritePinned: false,
    inHistory: true,
    groups: [],
  });
  const result = (id: string): ClipboardPage => ({
    entries: [entry(id)],
    total: 1,
    groups: [],
    settings: {
      paused: true,
      excludedApps: [],
      excludedText: [],
      retentionDays: null,
      visibleCount: null,
      quickKeys: "digits",
      quickAction: "paste",
      compactPosition: "cursor",
    },
    statistics: { entries: 1, favorites: 0, bytes: 0, databaseBytes: 0 },
  });
  let releaseOld: ((value: ClipboardPage) => void) | undefined;
  let releaseDetail: ((value: unknown) => void) | undefined;
  const commands: ClipboardRequest[] = [];
  const desktop = installDesktopBridge({
    window_control: () => false,
    clipboard_action: async (args) => {
      const command = args as ClipboardRequest;
      commands.push(command);
      if (command.action === "list") {
        if (command.query === "old")
          return new Promise<ClipboardPage>((resolve) => {
            releaseOld = resolve;
          });
        if (command.query === "new")
          return {
            ...result("latest result"),
            entries: [entry("latest result"), entry("another result")],
            total: 2,
          };
        return result("initial result");
      }
      if (command.action === "detail" && command.id === "latest result")
        return new Promise((resolve) => {
          releaseDetail = resolve;
        });
      if (command.action === "detail")
        return {
          ...entry(command.id),
          invalidFiles: [],
        };
      if (command.action === "copy" || command.action === "paste") return;
      throw new Error(`Unexpected clipboard action: ${command.action}`);
    },
  });
  const request = (command: ClipboardRequest) => invoke("clipboard_action", command);
  const view = await render(<ClipboardWorkspace request={request} />);
  try {
    await expect
      .element(page.getByRole("button", { name: "initial result", exact: false }))
      .toBeInTheDocument();
    // Type and favorites used to remain active together despite looking like one tab group.
    const filters = page.getByRole("group", { name: "内容筛选" });
    await filters.getByRole("button", { name: "文字", exact: true }).click();
    await expect
      .poll(() => commands.filter((command) => command.action === "list").at(-1))
      .toMatchObject({ action: "list", view: "history", kind: "text" });
    await page.getByRole("button", { name: "只看收藏", exact: true }).click();
    await expect
      .poll(() => commands.filter((command) => command.action === "list").at(-1))
      .toMatchObject({ action: "list", view: "favorites", kind: undefined });
    await expect
      .element(filters.getByRole("button", { name: "文字", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await expect
      .element(filters.getByRole("button", { name: "全部", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "只看收藏", exact: true }).click();
    await expect
      .element(filters.getByRole("button", { name: "只看收藏", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await filters.getByRole("button", { name: "图片", exact: true }).click();
    await expect
      .poll(() => commands.filter((command) => command.action === "list").at(-1))
      .toMatchObject({ action: "list", view: "history", kind: "image" });
    await expect
      .element(filters.getByRole("button", { name: "只看收藏", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await filters.getByRole("button", { name: "全部", exact: true }).click();
    await expect
      .poll(() => commands.filter((command) => command.action === "list").at(-1))
      .toMatchObject({ action: "list", view: "history", kind: undefined });
    const search = page.getByRole("textbox", { name: "搜索剪贴板" });
    await search.fill("old");
    await expect.poll(() => !!releaseOld).toBe(true);
    await search.fill("new");
    await expect
      .element(page.getByRole("button", { name: "latest result", exact: false }))
      .toBeInTheDocument();
    await expect.poll(() => !!releaseDetail).toBe(true);
    await expect.element(page.getByRole("region", { name: "内容预览" })).not.toBeInTheDocument();
    await act(async () => {
      releaseDetail!({ ...entry("latest result"), invalidFiles: [] });
    });
    await act(async () => {
      releaseOld!(result("stale result"));
    });
    await expect
      .element(page.getByRole("button", { name: "stale result", exact: false }))
      .not.toBeInTheDocument();
    const latest = page.getByRole("button", { name: "latest result", exact: false });
    await latest.click({ button: "right" });
    await expect
      .element(page.getByRole("menuitem", { name: "回贴原应用" }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "复制原格式", exact: true }).click();
    await expect
      .poll(() =>
        commands.some((command) => command.action === "copy" && command.id === "latest result"),
      )
      .toBe(true);
    const preview = page.getByRole("region", { name: "内容预览" });
    await expect.element(preview).toBeVisible();
    await preview.click({ button: "right" });
    await page.getByRole("menuitem", { name: "纯文本复制", exact: true }).click();
    await expect
      .poll(() =>
        commands.some(
          (command) =>
            command.action === "copy" && command.id === "latest result" && command.mode === "text",
        ),
      )
      .toBe(true);
    const originalCopies = commands.filter(
      (command) => command.action === "copy" && command.mode === "original",
    ).length;
    await expect.element(latest).toBeVisible();
    latest.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(
        () =>
          commands.filter((command) => command.action === "copy" && command.mode === "original")
            .length,
      )
      .toBe(originalCopies + 1);
    await page
      .getByRole("button", { name: "another result", exact: false })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制原格式", exact: true }).click();
    await expect
      .poll(() => commands.filter((command) => command.action === "copy").at(-1))
      .toMatchObject({ action: "copy", id: "another result", mode: "original" });
    expect(commands.some((command) => command.action === "paste")).toBe(false);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
