import { expect, test, vi } from "vitest";
import type { BackendContext } from "../../../apps/desktop/electron/plugins/backend-worker.js";
import { TrafficProcesses } from "./traffic-process";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../../apps/desktop/electron/plugins/native-runtime.js", () => ({
  createNativePluginRuntime: async () => ({ query }),
}));

test("live application totals count each run once and retain exited-member bytes across refreshes", async () => {
  const row = (id: string, runId: string, runRx: string) => ({
    processInstanceId: id,
    pid: Number(id),
    name: "Browser",
    imagePath: "C:/Browser/browser.exe",
    alive: true,
    rxBytes: "3",
    txBytes: "1",
    rxBytesPerSec: 3,
    txBytesPerSec: 1,
    runRxBytes: "2",
    runTxBytes: "1",
    appRunId: runId,
    appRunRxBytes: runRx,
    appRunTxBytes: runId === "first" ? "5" : "7",
    appRunCoverage: "gap",
  });
  let rows = [
    row("1", "first", "9007199254740993"),
    row("2", "first", "9007199254740993"),
    { ...row("3", "first", "9007199254740993"), alive: false },
    row("4", "another-user", "17"),
  ];
  query.mockImplementation(async (activation) => {
    const command = activation.parameters.command;
    if (command === "status")
      return {
        installed: true,
        serviceAvailable: true,
        collecting: true,
        enabled: true,
        hasLease: true,
      };
    if (command === "snapshot") return { processes: rows, snapshotId: "1" };
    return { icons: [] };
  });
  const processes = new TrafficProcesses(
    {
      owner: { pluginId: "spark233.traffic", version: "1", instanceId: "test" },
      signal: new AbortController().signal,
    } as BackendContext,
    () => {},
  );
  await processes.refresh();
  let current = processes.snapshot().processes;
  expect(current).toHaveLength(1);
  expect(current[0]!.instances.map((instance) => instance.pid)).toEqual([1, 2, 4]);
  expect(current[0]!.runRxBytes).toBe("9007199254741010");
  expect(current[0]!.runTxBytes).toBe("12");
  expect(current[0]!.rxBytes).toBe("9");
  expect(current[0]!.instances[0]!.runRxBytes).toBe("2");
  rows = rows.filter((item) => item.pid !== 2);
  await processes.refresh();
  current = processes.snapshot().processes;
  expect(current[0]!.runRxBytes).toBe("9007199254741010");
  expect(current[0]!.runTxBytes).toBe("12");
});
