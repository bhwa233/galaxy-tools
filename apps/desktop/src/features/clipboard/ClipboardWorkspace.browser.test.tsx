import { act } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { invoke } from "../../platform/desktop";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { ClipboardWorkspace } from "./ClipboardWorkspace";
import type { ClipboardEntry, ClipboardPage, ClipboardRequest } from "./types";

it("ignores a late search response and copies the selected entry", async () => {
  const entry = (id: string): ClipboardEntry => ({
    id,
    kind: "text",
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
      quickAction: "copy",
      compactPosition: "cursor",
    },
    statistics: { entries: 1, favorites: 0, bytes: 0, databaseBytes: 0 },
  });
  let releaseOld: ((value: ClipboardPage) => void) | undefined;
  const commands: ClipboardRequest[] = [];
  const desktop = installDesktopBridge({
    clipboard_action: async (args) => {
      const command = args as ClipboardRequest;
      commands.push(command);
      if (command.action === "list") {
        if (command.query === "old")
          return new Promise<ClipboardPage>((resolve) => {
            releaseOld = resolve;
          });
        return result(command.query === "new" ? "latest result" : "initial result");
      }
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
    await page.getByRole("button", { name: "只看收藏", exact: true }).click();
    await expect
      .poll(() => commands.filter((command) => command.action === "list").at(-1))
      .toMatchObject({ action: "list", view: "favorites" });
    await page.getByRole("button", { name: "只看收藏", exact: true }).click();
    const search = page.getByRole("textbox", { name: "搜索剪贴板" });
    await search.fill("old");
    await expect.poll(() => !!releaseOld).toBe(true);
    await search.fill("new");
    await expect
      .element(page.getByRole("button", { name: "latest result", exact: false }))
      .toBeInTheDocument();
    await act(async () => {
      releaseOld!(result("stale result"));
    });
    await expect
      .element(page.getByRole("button", { name: "stale result", exact: false }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "复制此条目" }).click();
    await expect
      .poll(() =>
        commands.some((command) => command.action === "copy" && command.id === "latest result"),
      )
      .toBe(true);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
