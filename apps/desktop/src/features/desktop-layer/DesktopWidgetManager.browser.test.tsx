import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { LayerManagementState } from "../../../shared/layer-contract";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { DesktopWidgetManager } from "./DesktopWidgetManager";

it("retries the failed placement and locates the recovered window without creating content", async () => {
  const id = "36ac0a27-3db8-401b-b41a-c4958ddca9ba";
  const state: LayerManagementState = {
    templates: [],
    instances: [
      {
        widgetInstanceId: id,
        pluginId: "fixture.windows",
        widgetDefinitionId: "main",
        title: "恢复的窗口",
        environment: "card-desktop",
        displayId: "workspace",
        visible: true,
        status: "fault",
        reason: "恢复失败，原内容已保留",
        canRetry: true,
        canLocate: true,
      },
    ],
  };
  let fail = true;
  const desktop = installDesktopBridge({
    layer_listTemplates: () => structuredClone(state),
    layer_retry: (args) => {
      expect(args).toEqual({ widgetInstanceId: id });
      if (fail) throw new Error("插件仍不可用");
      Object.assign(state.instances[0], { status: "active", reason: undefined, canRetry: false });
    },
    layer_locate: () => undefined,
  });
  const view = await render(<DesktopWidgetManager />);
  try {
    await expect.element(page.getByText("恢复失败，原内容已保留")).toBeVisible();
    await page.getByRole("button", { name: "重新加载卡片：恢复的窗口" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("插件仍不可用");
    fail = false;
    await page.getByRole("button", { name: "重新加载卡片：恢复的窗口" }).click();
    await expect.element(page.getByText("显示中", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "定位 恢复的窗口", exact: true }).click();
    await expect
      .poll(() => desktop.calls.filter((call) => call.command === "layer_locate"))
      .toHaveLength(1);
    expect(desktop.calls.find((call) => call.command === "layer_locate")?.args).toEqual({
      widgetInstanceId: id,
    });
    expect(desktop.calls.some((call) => call.command === "layer_create")).toBe(false);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});
