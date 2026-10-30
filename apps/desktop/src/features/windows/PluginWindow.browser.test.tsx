import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { StrictMode } from "react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { registerHostPreparation } from "./hostPreparation";
import { PluginWindow } from "./PluginWindow";
import type { PluginWindowActivation } from "../../../shared/plugin-windows";

const owner = { pluginId: "fixture.tools", version: "1.0.0", instanceId: "current" };
function transport(take: () => unknown) {
  return installDesktopBridge({
    config_get: () => ({ theme: "light", locale: "zh-CN" }),
    desktop_ready: () => undefined,
    plugin_window_info: () => ({
      pluginId: owner.pluginId,
      profile: "main",
      title: "Fixture",
      presentation: "standard",
      commands: [],
    }),
    plugin_window_take_activation: take,
    window_control: () => undefined,
  });
}

it("keeps a newer plugin activation when the initial read finishes late and never queries the launcher", async () => {
  let complete!: (value: PluginWindowActivation) => void;
  const desktop = transport(
    () =>
      new Promise<PluginWindowActivation>((resolve) => {
        complete = resolve;
      }),
  );
  const view = await render(
    <StrictMode>
      <PluginWindow>
        {({ payload }) => (
          <input
            aria-label="Plugin input"
            readOnly
            value={(payload as { query: string } | undefined)?.query ?? ""}
          />
        )}
      </PluginWindow>
    </StrictMode>,
  );
  try {
    await expect.poll(() => !!complete).toBe(true);
    desktop.emit("plugin-window-activation", { revision: 2, owner, payload: { query: "latest" } });
    complete({ revision: 1, owner, payload: { query: "stale" } });
    await expect.element(page.getByRole("textbox", { name: "Plugin input" })).toHaveValue("latest");
    expect(
      desktop.calls.filter((call) => call.command === "plugin_window_take_activation"),
    ).toHaveLength(1);
    const infoReads = desktop.calls.filter((call) => call.command === "plugin_window_info").length;
    desktop.emit("plugins-changed");
    await expect
      .poll(() => desktop.calls.filter((call) => call.command === "plugin_window_info").length)
      .toBe(infoReads + 1);
    await expect.element(page.getByRole("textbox", { name: "Plugin input" })).toHaveValue("latest");
    expect(desktop.calls.some((call) => call.command.startsWith("launcher_"))).toBe(false);
  } finally {
    complete?.({ revision: 0, owner, payload: {} });
    await view.unmount();
    desktop.restore();
  }
});

it("keeps the plugin window and its input when preparation refuses a close", async () => {
  const desktop = transport(() => ({ revision: 1, owner, payload: { query: "unsaved" } }));
  const unregister = registerHostPreparation(async () => {
    throw new Error("Save refused");
  });
  const view = await render(
    <PluginWindow>
      {({ payload, onClose }) => (
        <>
          <input
            aria-label="Draft"
            readOnly
            value={(payload as { query: string } | undefined)?.query ?? ""}
          />
          <button onClick={() => void onClose()}>Close fixture</button>
        </>
      )}
    </PluginWindow>,
  );
  try {
    await expect.element(page.getByRole("textbox", { name: "Draft" })).toHaveValue("unsaved");
    await page.getByRole("button", { name: "Close fixture" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Save refused");
    expect(desktop.calls.some((call) => call.command === "window_control")).toBe(false);
    await expect.element(page.getByRole("textbox", { name: "Draft" })).toHaveValue("unsaved");
  } finally {
    unregister();
    await view.unmount();
    desktop.restore();
  }
});
