import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { JsonValue } from "../../../../../packages/sdk/src/index";
import type { TrafficState } from "../../../../../packages/official/traffic/traffic-contract";
import { installPluginBridge } from "../../test/browser/desktop-bridge";

it("keeps a menu's captured process targets through polling and requires explicit termination confirmation", async () => {
  const instance = (id: string, pid: number) => ({
    id,
    pid,
    name: "fixture.exe",
    executable: "C:/fixture.exe",
    rxBytesPerSecond: 1,
    txBytesPerSecond: 0,
    rxBytes: "1",
    txBytes: "0",
    tcpConnections: 1,
    udpFlows: 0,
  });
  let instances = [instance("old-child", 123), instance("second-child", 124)];
  const snapshot = (): TrafficState => ({
    source: "interface-totals",
    scope: "active-physical-adapters",
    collectorEpoch: "one",
    coverage: "complete",
    at: Date.now(),
    intervalMs: 1000,
    rxBytesPerSecond: 1,
    txBytesPerSecond: 0,
    adapters: [],
    rxSeries: [],
    txSeries: [],
    paused: false,
    collectorPid: null,
    process: {
      status: "collecting",
      scope: "own",
      canEnable: true,
      canMachine: true,
      coverage: "complete",
    },
    icons: {},
    processes: [
      {
        id: "a".repeat(32),
        appId: "a".repeat(32),
        name: "fixture.exe",
        executable: "C:/fixture.exe",
        category: "application",
        rxBytesPerSecond: 1,
        txBytesPerSecond: 0,
        rxBytes: "1",
        txBytes: "0",
        tcpConnections: 1,
        udpFlows: 0,
        instances,
      },
    ],
  });
  const actions: Record<string, JsonValue>[] = [];
  let reads = 0;
  const restore = installPluginBridge(
    async (operation, payload): Promise<JsonValue | undefined> => {
      if (operation === "context.get")
        return {
          owner: { pluginId: "spark233.traffic", version: "test", instanceId: "fixture" },
          theme: { effective: "dark" },
        };
      if (operation === "window.isMaximized") return false;
      if (operation !== "capability.invoke") return undefined;
      const input = payload as {
        payload: { commandId: string; parameters: Record<string, JsonValue> };
      };
      if (input.payload.commandId === "snapshot") {
        reads++;
        return snapshot() as unknown as JsonValue;
      }
      if (input.payload.commandId === "process.action") {
        actions.push(input.payload.parameters);
        return {
          results: (input.payload.parameters.processInstanceIds as string[]).map((instanceId) => ({
            instanceId,
            status: input.payload.parameters.action === "terminate" ? "terminated" : "opened",
          })),
        };
      }
      throw new Error(`Unexpected traffic command: ${input.payload.commandId}`);
    },
  );
  const { TrafficPage } = await import("../../../../../packages/official/traffic/renderer/main");
  const view = await render(<TrafficPage />);
  try {
    await page.getByRole("button", { name: "更多操作 · fixture.exe", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: "定位文件" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "文件属性" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "查看连接" })).toBeVisible();
    const before = reads;
    instances = [instance("new-child", 999)];
    await expect.poll(() => reads).toBeGreaterThan(before);
    await page.getByRole("menuitem", { name: "结束全部进程（2）" }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect.element(page.getByText("PID 123", { exact: true })).toBeVisible();
    expect(actions).toHaveLength(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(actions).toHaveLength(0);
    await page.getByRole("button", { name: "更多操作 · fixture.exe", exact: true }).click();
    await page.getByRole("menuitem", { name: "结束进程", exact: true }).click();
    await page.getByRole("button", { name: "确认结束", exact: true }).click();
    await expect.poll(() => actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      processInstanceIds: ["new-child"],
      action: "terminate",
      confirmed: true,
      scope: "own",
    });
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    // The row context menu uses the same actions as the visible ellipsis.
    const row = view.container.querySelector("tbody tr")!;
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 260, button: 2 }),
    );
    await page.getByRole("menuitem", { name: "文件属性", exact: true }).click();
    await expect.poll(() => actions.length).toBe(2);
    expect(actions[1]).toMatchObject({ action: "properties", processInstanceIds: ["new-child"] });
  } finally {
    await view.unmount();
    restore();
  }
});
