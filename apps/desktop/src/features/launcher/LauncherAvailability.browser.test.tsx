import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { Launcher } from "./Launcher";
import type { LauncherItem, LauncherState } from "./types";

test("disabling a plugin prevents its old candidate from executing while another entry remains usable", async () => {
  let pluginEnabled = true;
  const retired: LauncherItem = {
    id: "owned-retired-selection",
    pluginId: "fixture.retired",
    commandId: "open",
    kind: "command",
    title: "待停用插件入口",
  };
  const available: LauncherItem = {
    id: "owned-available-selection",
    pluginId: "fixture.available",
    commandId: "open",
    kind: "command",
    title: "仍可用插件入口",
  };
  const desktop = installDesktopBridge({
    launcher_state: (): LauncherState => ({
      firstRun: false,
      pluginsReady: true,
      commands: [retired, available].map((item) => ({
        id: item.commandId!,
        pluginId: item.pluginId,
        title: item.title,
        keywords: [],
        enabled: item.pluginId === retired.pluginId ? pluginEnabled : true,
      })),
    }),
    launcher_take_workspace: () => undefined,
    launcher_cancel_query: () => undefined,
    launcher_query: (value) => {
      const { query, sessionId } = value as { query: string; sessionId: string };
      return {
        sessionId,
        // Keep the old candidate in the returned list to exercise the real
        // Launcher's enabled-command guard, independently of backend filtering.
        items: query === "可用性" ? [retired, available] : [],
      };
    },
    launcher_execute: () => undefined,
  });
  const view = await render(<Launcher />);
  try {
    const search = page.getByRole("combobox", { name: "搜索应用、插件与操作" });
    await search.fill("可用性");
    const oldCandidate = page.getByRole("option", { name: retired.title, exact: false });
    const otherCandidate = page.getByRole("option", { name: available.title, exact: false });
    await expect.element(oldCandidate).toBeVisible();
    await expect.element(oldCandidate).toHaveAttribute("aria-selected", "true");
    await expect.element(oldCandidate).toHaveAttribute("aria-disabled", "false");

    pluginEnabled = false;
    desktop.emit("plugins-changed");
    await expect.element(oldCandidate).toHaveAttribute("aria-disabled", "true");
    await expect.element(otherCandidate).toHaveAttribute("aria-disabled", "false");
    await userEvent.keyboard("{Enter}");
    expect(
      desktop.calls.some(
        (call) =>
          call.command === "launcher_execute" && (call.args as { id?: string })?.id === retired.id,
      ),
    ).toBe(false);

    await userEvent.click(otherCandidate);
    await expect
      .poll(() =>
        desktop.calls
          .filter((call) => call.command === "launcher_execute")
          .map((call) => call.args),
      )
      .toContainEqual({
        id: available.id,
        pluginId: available.pluginId,
        commandId: available.commandId,
      });
    expect(
      desktop.calls
        .filter((call) => call.command === "launcher_execute")
        .every((call) => (call.args as { id?: string })?.id === available.id),
    ).toBe(true);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
