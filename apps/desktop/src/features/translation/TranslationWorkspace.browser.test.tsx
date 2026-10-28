import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { TranslationWorkspace } from "./TranslationWorkspace";
import type { TranslationHistoryEntry } from "./types";

const entry: TranslationHistoryEntry = {
  id: "history-1",
  at: "2026-10-28T07:30:00.000Z",
  target: "en",
  text: "早上好",
  translatedText: "Good morning",
  model: "fixture-model",
  cached: false,
  source: "workspace",
};

const workspace = (overrides: { autoLookup?: boolean; history?: boolean } = {}) =>
  installDesktopBridge({
    translation_action: (args) => {
      const action = (args as { action: string }).action;
      if (action === "config_status")
        return {
          kind: "translation-config",
          configured: true,
          endpoint: "",
          model: "",
          hasKey: false,
        };
      if (action === "preferences_get" || action === "preferences_set")
        return {
          kind: "translation-preferences",
          autoLookup: overrides.autoLookup ?? true,
          historyEnabled: true,
        };
      if (action === "history_list")
        return {
          kind: "translation-history",
          entries: overrides.history ? [entry] : [],
          enabled: true,
        };
      if (action === "search")
        return {
          kind: "dictionary-search",
          items: [{ id: "dict:hello", title: "hello", description: "int. 你好" }],
        };
      throw new Error(`Unexpected translation action: ${action}`);
    },
  });

// Reopening the workspace must show what the plugin stored, and choosing an
// entry must restore both panes without calling the model again.
it("lists stored history and restores both panes without translating", async () => {
  const desktop = workspace({ history: true });
  const view = await render(
    <TranslationWorkspace notesAvailable onClose={() => {}} unavailableTargetReason="" />,
  );
  try {
    await page.getByRole("button", { name: "历史" }).click();
    await expect.element(page.getByRole("button", { name: /早上好/ })).toBeVisible();
    expect(desktop.calls.filter((call) => call.command === "translation_action")).toEqual([
      expect.objectContaining({ args: { action: "config_status" } }),
      expect.objectContaining({ args: { action: "preferences_get" } }),
      expect.objectContaining({ args: { action: "history_list" } }),
    ]);

    await page.getByRole("button", { name: /早上好/ }).click();
    await expect.element(page.getByRole("textbox", { name: "原文" })).toHaveValue("早上好");
    await expect.element(page.getByText("Good morning")).toBeVisible();
    expect(
      desktop.calls.filter(
        (call) => (call.args as { action?: string } | undefined)?.action === "translate",
      ),
    ).toEqual([]);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("looks up a selection once and stops doing so after the preference is turned off", async () => {
  const desktop = workspace();
  const view = await render(
    <TranslationWorkspace notesAvailable onClose={() => {}} unavailableTargetReason="" />,
  );
  const searches = () =>
    desktop.calls
      .filter((call) => call.command === "translation_action")
      .map((call) => call.args as { action: string; query?: string })
      .filter((args) => args.action === "search");
  try {
    const source = page.getByRole("textbox", { name: "原文" });
    await userEvent.fill(source, "hello world");
    const element = source.element() as HTMLTextAreaElement;
    element.setSelectionRange(0, 5);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await expect.element(page.getByRole("complementary", { name: "离线词典" })).toBeVisible();
    expect(searches()).toEqual([expect.objectContaining({ query: "hello" })]);

    await page.getByRole("button", { name: "选中即查：开" }).click();
    await expect.element(page.getByRole("button", { name: "选中即查：关" })).toBeVisible();
    element.setSelectionRange(6, 11);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await page.getByRole("button", { name: "清空" }).click();
    await expect.element(page.getByRole("textbox", { name: "原文" })).toHaveValue("");
    expect(searches()).toEqual([expect.objectContaining({ query: "hello" })]);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
