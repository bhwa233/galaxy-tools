import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { TranslationWorkspace } from "./TranslationWorkspace";
import { ToastContainer } from "../../components/Toast";
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

const workspace = (
  overrides: {
    autoLookup?: boolean;
    history?: boolean;
    configured?: boolean;
    copy?: () => unknown;
    translate?: (args: unknown) => unknown;
    cancel?: (args: unknown) => unknown;
    search?: (args: unknown) => unknown;
    dictionaryHistory?: (args: unknown) => unknown;
  } = {},
) =>
  installDesktopBridge({
    window_control: () => false,
    settings_open: () => undefined,
    clipboard_write: () => overrides.copy?.(),
    translation_action: (args) => {
      const action = (args as { action: string }).action;
      if (action === "config_status")
        return {
          kind: "translation-config",
          configured: overrides.configured ?? true,
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
        return (
          overrides.search?.(args) ?? {
            kind: "dictionary-search",
            items: [{ id: "dict:hello", title: "hello", description: "int. 你好" }],
          }
        );
      if (action === "detail")
        return {
          kind: "dictionary-entry",
          entry: {
            id: (args as { id: string }).id,
            word: "hello",
            translation: "你好",
            phonetic: "",
            definition: "",
            pos: "",
            tags: "",
            exchange: "",
          },
          related: [],
        };
      if (
        action === "dictionary_history_list" ||
        action === "dictionary_history_clear" ||
        action === "dictionary_history_delete"
      )
        return overrides.dictionaryHistory?.(args) ?? { kind: "dictionary-history", entries: [] };
      if (action === "translate" && overrides.translate) return overrides.translate(args);
      if (action === "cancel" && overrides.cancel) return overrides.cancel(args);
      throw new Error(`Unexpected translation action: ${action}`);
    },
  });

it("automatically displays a lookup and restores and deletes search history", async () => {
  let entries = [{ query: "hello", at: "2026-10-29T08:00:00Z" }];
  const desktop = workspace({
    dictionaryHistory: (args) => {
      const request = args as { action: string; query?: string };
      if (request.action === "dictionary_history_delete")
        entries = entries.filter((entry) => entry.query !== request.query);
      if (request.action === "dictionary_history_clear") entries = [];
      return { kind: "dictionary-history", entries };
    },
  });
  const view = await render(
    <TranslationWorkspace
      initialResult={{ kind: "dictionary-input", query: "hello" }}
      notesAvailable
      onClose={() => {}}
      unavailableTargetReason=""
    />,
  );
  try {
    await expect.element(page.getByText("你好", { exact: true })).toBeVisible();
    expect(
      desktop.calls.some(
        (call) =>
          (call.args as { action?: string; recordHistory?: boolean })?.recordHistory === true,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "搜索历史" }).click();
    await expect.element(page.getByRole("button", { name: "hello", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "hello", exact: true }).click();
    await expect.element(page.getByText("你好", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "搜索历史" }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await expect.element(page.getByText("还没有查词记录")).toBeVisible();
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("opens dictionary handoffs offline and ignores an older lookup result", async () => {
  let resolveFirst!: (value: unknown) => void;
  const first = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });
  const desktop = workspace({
    search: (args) =>
      (args as { query: string }).query === "old"
        ? first
        : { kind: "dictionary-search", items: [{ id: "new", title: "new result" }] },
  });
  const props = { notesAvailable: true, onClose: () => {}, unavailableTargetReason: "" };
  const view = await render(
    <TranslationWorkspace {...props} initialResult={{ kind: "dictionary-input", query: "old" }} />,
  );
  try {
    await expect
      .poll(() => desktop.calls.some((call) => (call.args as { query?: string })?.query === "old"))
      .toBe(true);
    await view.rerender(
      <TranslationWorkspace
        {...props}
        initialResult={{ kind: "dictionary-input", query: "new" }}
      />,
    );
    await expect.element(page.getByRole("textbox", { name: "单词或短语" })).toHaveValue("new");
    await expect.element(page.getByText("new result")).toBeVisible();
    resolveFirst({ kind: "dictionary-search", items: [{ id: "old", title: "old result" }] });
    await expect.element(page.getByText("old result")).not.toBeInTheDocument();
    expect(
      desktop.calls.some((call) => (call.args as { action?: string })?.action === "translate"),
    ).toBe(false);
    await view.rerender(
      <TranslationWorkspace {...props} initialResult={{ kind: "dictionary-input", query: "" }} />,
    );
    await expect.element(page.getByRole("textbox", { name: "单词或短语" })).toHaveValue("");
  } finally {
    resolveFirst(undefined);
    await view.unmount();
    desktop.restore();
  }
});

it("executes an explicit launcher translation once and keeps ordinary handoffs offline", async () => {
  const source = "Translate this entire paragraph.\n保留第二段。";
  const desktop = workspace({
    translate: (args) => ({
      kind: "translation",
      ...(args as object),
      translatedText: "完成的译文",
      cached: false,
    }),
  });
  const initial = { kind: "translate-input", text: source, translateRequestId: "launcher-request" };
  const view = await render(
    <TranslationWorkspace
      initialResult={initial}
      notesAvailable
      onClose={() => {}}
      unavailableTargetReason=""
    />,
  );
  const translations = () =>
    desktop.calls.filter((call) => (call.args as { action?: string })?.action === "translate");
  try {
    await expect.element(page.getByText("完成的译文")).toBeVisible();
    expect(translations()).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ text: source, requestId: "launcher-request" }),
      }),
    ]);
    await view.rerender(
      <TranslationWorkspace
        initialResult={{ ...initial }}
        notesAvailable
        onClose={() => {}}
        unavailableTargetReason=""
      />,
    );
    await view.rerender(
      <TranslationWorkspace
        initialResult={{ kind: "translate-input", text: "只带入原文" }}
        notesAvailable
        onClose={() => {}}
        unavailableTargetReason=""
      />,
    );
    await expect.element(page.getByRole("textbox", { name: "原文" })).toHaveValue("只带入原文");
    expect(translations()).toHaveLength(1);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

it("preserves an active translation when switching between dictionary and translation", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const desktop = workspace({ translate: () => pending });
  const view = await render(
    <TranslationWorkspace
      initialResult={{ kind: "translate-input", text: "hello world", translateRequestId: "active" }}
      notesAvailable
      onClose={() => {}}
      unavailableTargetReason=""
    />,
  );
  try {
    await expect.element(page.getByRole("button", { name: "停止" })).toBeVisible();
    await page.getByRole("button", { name: "离线词典" }).click();
    await expect.element(page.getByRole("textbox", { name: "单词或短语" })).toBeVisible();
    finish({ kind: "translation", text: "hello world", translatedText: "你好世界" });
    await page.getByRole("button", { name: "AI 翻译" }).click();
    await expect.element(page.getByRole("textbox", { name: "原文" })).toHaveValue("hello world");
    await expect.element(page.getByText("你好世界")).toBeVisible();
    expect(
      desktop.calls.some((call) => (call.args as { action?: string })?.action === "cancel"),
    ).toBe(false);
  } finally {
    finish(undefined);
    await view.unmount();
    desktop.restore();
  }
});

// The shared title bar must retain the translation workspace's existing policy:
// request cancellation and await its acknowledgement before running onClose.
it("waits for active translation cancellation before closing from the title bar", async () => {
  let finish!: (value: unknown) => void;
  let cancelled!: () => void;
  let closed = 0;
  const desktop = workspace({
    translate: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    cancel: () =>
      new Promise<void>((resolve) => {
        cancelled = resolve;
      }),
  });
  const view = await render(
    <TranslationWorkspace
      initialResult={{
        kind: "translate-input",
        text: "hello world",
        translateRequestId: "closing",
      }}
      notesAvailable
      onClose={() => {
        closed++;
      }}
      unavailableTargetReason=""
    />,
  );
  try {
    await expect.element(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect
      .poll(() =>
        desktop.calls.some(
          (call) =>
            call.command === "translation_action" &&
            (call.args as { action: string; requestId: string }).action === "cancel" &&
            (call.args as { requestId: string }).requestId === "closing",
        ),
      )
      .toBe(true);
    expect(closed).toBe(0);
    cancelled();
    await expect.poll(() => closed).toBe(1);
  } finally {
    cancelled?.();
    finish?.(undefined);
    await view.unmount();
    desktop.restore();
  }
});

it("preserves launcher input and opens configuration without sending a model request when unconfigured", async () => {
  const desktop = workspace({ configured: false });
  const source = "This paragraph must remain available while configuring the service.";
  const view = await render(
    <TranslationWorkspace
      initialResult={{ kind: "translate-input", text: source, translateRequestId: "needs-config" }}
      notesAvailable
      onClose={() => {}}
      unavailableTargetReason=""
    />,
  );
  try {
    await expect
      .poll(() => desktop.calls.filter((call) => call.command === "settings_open").length)
      .toBe(1);
    await expect.element(page.getByRole("textbox", { name: "原文" })).toHaveValue(source);
    expect(
      desktop.calls.some((call) => (call.args as { action?: string })?.action === "translate"),
    ).toBe(false);
  } finally {
    await view.unmount();
    desktop.restore();
  }
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
    await page.getByRole("button", { name: "AI 翻译" }).click();
    await expect.element(source).toHaveValue("hello world");
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

// Copy success used to insert a permanent row below the title bar. Confirm the
// host write finishes first and both success/failure keep the query in place.
it("shows copy feedback only after completion without moving the dictionary layout", async () => {
  let complete!: () => void;
  let fail = false;
  const desktop = workspace({
    copy: () =>
      fail
        ? Promise.reject(new Error("Copy fixture failed"))
        : new Promise<void>((resolve) => {
            complete = resolve;
          }),
  });
  const view = await render(
    <>
      <TranslationWorkspace
        initialResult={{ kind: "dictionary-input", query: "hello" }}
        notesAvailable
        onClose={() => {}}
        unavailableTargetReason=""
      />
      <ToastContainer />
    </>,
  );
  try {
    const copy = page.getByRole("button", { name: "复制", exact: true });
    await expect.element(copy).toBeVisible();
    const query = page.getByRole("textbox").first();
    const top = query.element().getBoundingClientRect().top;
    await copy.click();
    await expect.poll(() => !!complete).toBe(true);
    expect(document.querySelector('[data-slot="toast"]')).toBeNull();
    complete();
    const viewport = page.getByRole("region", { name: "操作通知", exact: true });
    await expect.element(viewport.getByText("已复制", { exact: true })).toBeVisible();
    expect(query.element().getBoundingClientRect().top).toBe(top);
    await userEvent.hover(viewport.getByText("已复制", { exact: true }));
    await viewport.getByRole("button", { name: "关闭通知", exact: true }).click();
    await expect.element(viewport.getByText("已复制", { exact: true })).not.toBeInTheDocument();
    fail = true;
    await copy.click();
    await expect.element(viewport.getByText("Copy fixture failed", { exact: true })).toBeVisible();
    await expect.element(query).toHaveValue("hello");
    expect(query.element().getBoundingClientRect().top).toBe(top);
  } finally {
    complete?.();
    await view.unmount();
    desktop.restore();
  }
});
