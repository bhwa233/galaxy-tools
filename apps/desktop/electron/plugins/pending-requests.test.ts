import { expect, test, vi } from "vitest";
import { PendingRequests } from "./pending-requests.js";

test("settles once and releases timers on every path", async () => {
  vi.useFakeTimers();
  try {
    const requests = new PendingRequests<string>(2);
    const onTimeout = vi.fn(() => new Error("timed out"));
    const timed = requests.open("a", { timeoutMs: 100, onTimeout, meta: "activate" });
    expect(requests.meta("a")).toBe("activate");
    const controller = new AbortController();
    const aborted = requests.open("b", { timeoutMs: 100, signal: controller.signal, meta: "x" });
    await expect(requests.open("c", { timeoutMs: 100, meta: "x" })).rejects.toThrow(/Too many/);
    controller.abort();
    await expect(aborted).rejects.toThrow("Request cancelled");
    vi.advanceTimersByTime(100);
    await expect(timed).rejects.toThrow("timed out");
    expect(onTimeout).toHaveBeenCalledOnce();
    // A late response after the timeout must not settle anything.
    expect(requests.resolve("a", 1)).toBe(false);
    const done = requests.open("d", { timeoutMs: 100, meta: "x" });
    expect(requests.resolve("d", 42)).toBe(true);
    await expect(done).resolves.toBe(42);
    const left = requests.open("e", { timeoutMs: 100, meta: "x" });
    requests.rejectAll(new Error("exited"));
    await expect(left).rejects.toThrow("exited");
    expect(requests.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
