import { describe, expect, it, vi } from "vitest";
import { SelectionLauncher } from "./selection-launcher.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native selection handoff to the existing launcher", () => {
  it("captures the paste target alongside selection reading before showing the launcher", async () => {
    const selection = deferred<string>();
    const target = deferred<void>();
    const read = vi.fn(() => selection.promise);
    const prepare = vi.fn(() => target.promise);
    const present = vi.fn();
    const launcher = new SelectionLauncher({ read, prepare, present });
    const opening = launcher.open();
    expect(read).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    selection.resolve("selected");
    await Promise.resolve();
    expect(present).not.toHaveBeenCalled();
    target.resolve();
    await opening;
    expect(present.mock.calls[0][0]).toBe("selected");
  });
  it("keeps focus at the source until capture finishes and prevents late A from replacing B", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const present = vi.fn();
    const launcher = new SelectionLauncher({ read, present });
    const first = launcher.open();
    expect(present).not.toHaveBeenCalled();
    const second = launcher.open();
    expect(read.mock.calls[0][0].aborted).toBe(true);
    b.resolve("完整选区。\n" + "a".repeat(9000));
    await second;
    expect(present).toHaveBeenCalledOnce();
    expect(present.mock.calls[0][0]).toBe("完整选区。\n" + "a".repeat(9000));
    a.resolve("已经过期的选区");
    await first;
    expect(present).toHaveBeenCalledOnce();
  });

  it("opens empty input on read failure and cancels pending reads on ordinary opening or shutdown", async () => {
    const late = deferred<string>();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce("old selection")
      .mockRejectedValueOnce(new Error("UIA unavailable"))
      .mockReturnValue(late.promise);
    const present = vi.fn();
    const launcher = new SelectionLauncher({ read, present });
    await launcher.open();
    await launcher.open();
    expect(present.mock.calls.map(([text]) => text)).toEqual(["old selection", ""]);
    const pending = launcher.open();
    launcher.cancel();
    late.resolve("late selection");
    await pending;
    expect(present).toHaveBeenCalledTimes(2);
    launcher.stop();
    await launcher.open();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
