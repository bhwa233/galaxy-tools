import { expect, test, vi } from "vitest";
import { assertWidgetJson } from "../../sdk/src/index.js";
import { TrafficPages } from "./traffic-pages";
import type { TrafficState } from "./traffic-contract";

test("bounded display pages preserve all instances and icons while fencing expired or unrelated cursors", () => {
  vi.useFakeTimers();
  try {
    const pages = new TrafficPages();
    const icon = "data:image/png;base64," + "a".repeat(10_000);
    const processes = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      appId: String(index),
      name: "Program",
      executable: "C:/" + "x".repeat(500),
      rxBytes: "9007199254740993",
      txBytes: "0",
      rxBytesPerSecond: 1,
      txBytesPerSecond: 0,
      category: "application",
      tcpConnections: 0,
      udpFlows: 0,
      iconId: "app-" + index,
      instances: Array.from({ length: 25 }, (_unused, instance) => ({
        id: `${index}:${instance}`,
        pid: instance,
      })),
    }));
    // An absent optional message in a real collecting state used to prevent
    // startup as soon as the first process row reached the wire validator.
    let page = pages.pack("snapshot", {
      process: { status: "collecting", message: undefined },
      processes,
      icons: Object.fromEntries(processes.map((row) => [row.iconId, icon])),
    } as unknown as TrafficState) as Record<string, unknown>;
    const firstCursor = page.nextCursor;
    expect(typeof firstCursor).toBe("string");
    expect(() => pages.next("history", firstCursor)).toThrow();
    const ids = new Set<string>();
    const icons: Record<string, string> = {};
    let count = 0;
    for (;;) {
      assertWidgetJson(page, 64 * 1024, 12, 4096);
      for (const row of page.processes as typeof processes) {
        expect(row.rxBytes).toBe("9007199254740993");
        for (const instance of row.instances) ids.add(instance.id);
      }
      for (const [id, chunks] of Object.entries(page.iconChunks as Record<string, string[]>))
        icons[id] = (icons[id] ?? "") + chunks.join("");
      count++;
      if (!page.nextCursor) break;
      page = pages.next("snapshot", page.nextCursor) as Record<string, unknown>;
    }
    expect(count).toBeGreaterThan(1);
    expect(ids.size).toBe(1000);
    expect(Object.values(icons).length).toBe(40);
    expect(Object.values(icons).every((value) => value === icon)).toBe(true);
    const expired = pages.pack("history", {
      rows: Array.from({ length: 100 }, (_, id) => ({ id, name: "x".repeat(1000) })),
    }) as Record<string, unknown>;
    vi.advanceTimersByTime(30_001);
    expect(() => pages.next("history", expired.nextCursor)).toThrow();
  } finally {
    vi.useRealTimers();
  }
});
