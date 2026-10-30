import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PluginConfiguration } from "../plugins/PluginConfiguration";
import { prepareHostWindow } from "../windows/hostPreparation";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";

it("keeps edits local, retains a failed save, and lets the user cancel or discard leaving", async () => {
  let fail = true;
  let savedModel = "saved-model";
  const desktop = installDesktopBridge({
    plugin_settings_get: () => ({
      pluginId: "fixture.plugin",
      revision: "original",
      fields: [{ key: "model", type: "text", label: "translation.model" }],
      values: { model: savedModel },
    }),
    plugin_settings_save: () => {
      if (fail) throw new Error("Disk unavailable");
      savedModel = "new-model";
      return {
        pluginId: "fixture.plugin",
        revision: "updated",
        fields: [{ key: "model", type: "text", label: "translation.model" }],
        values: { model: "new-model" },
      };
    },
  });
  const view = await render(<PluginConfiguration pluginId="fixture.plugin" />);
  try {
    const input = page.getByRole("textbox", { name: "模型名" });
    await expect.element(input).toHaveValue("saved-model");
    await input.fill("new-model");
    expect(desktop.calls.filter((call) => call.command === "plugin_settings_save")).toEqual([]);
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.element(page.getByText("Disk unavailable", { exact: true })).toBeVisible();
    await expect.element(input).toHaveValue("new-model");
    const cancelled = prepareHostWindow().then(
      () => "ready",
      () => "cancelled",
    );
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(await cancelled).toBe("cancelled");
    await expect.element(input).toHaveValue("new-model");
    fail = false;
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.element(page.getByTestId("plugin-save-status")).toBeVisible();
    await prepareHostWindow();
    await input.fill("unsaved-again");
    const discarded = prepareHostWindow();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "放弃更改", exact: true })
      .click();
    await discarded;
    await expect.element(input).toHaveValue("new-model");
    expect(desktop.calls.filter((call) => call.command === "plugin_settings_save")).toHaveLength(2);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
