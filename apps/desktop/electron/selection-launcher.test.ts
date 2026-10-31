import { describe, expect, it, vi } from "vitest";
import { SelectionLauncher } from "./selection-launcher.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe("native selection handoff to the existing launcher", () => {
  it("shows the panel before the selection read finishes, then patches the text", async () => {
    const selection = deferred<string>();
    const read = vi.fn<(signal: AbortSignal, target: number) => Promise<string>>(
      () => selection.promise,
    );
    const target = vi.fn(async () => 1234);
    const present = vi.fn();
    const patch = vi.fn();
    const launcher = new SelectionLauncher({ target, read, present, patch });
    const opening = launcher.open();
    await flush();
    // The panel is already up while the UIA read is still pending.
    expect(present).toHaveBeenCalledOnce();
    expect(present.mock.calls[0][0]).toBe("");
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][1]).toBe(1234);
    expect(patch).not.toHaveBeenCalled();
    selection.resolve("selected");
    await opening;
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0][0]).toBe("selected");
  });

  it("never overwrites the newer press with a late selection from the previous one", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const read = vi
      .fn<(signal: AbortSignal, target: number) => Promise<string>>()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const present = vi.fn();
    const patch = vi.fn();
    const launcher = new SelectionLauncher({ target: async () => 0, read, present, patch });
    const first = launcher.open();
    await flush();
    expect(read.mock.calls[0][0].aborted).toBe(false);
    const second = launcher.open();
    expect(read.mock.calls[0][0].aborted).toBe(true);
    expect(read.mock.calls[0][1]).toBe(0);
    b.resolve("完整选区。\n" + "a".repeat(9000));
    await second;
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0][0]).toBe("完整选区。\n" + "a".repeat(9000));
    a.resolve("已经过期的选区");
    await first;
    expect(patch).toHaveBeenCalledOnce();
  });

  it("opens empty input on read failure and cancels pending reads on ordinary opening or shutdown", async () => {
    const late = deferred<string>();
    const read = vi
      .fn<(signal: AbortSignal, target: number) => Promise<string>>()
      .mockResolvedValueOnce("old selection")
      .mockRejectedValueOnce(new Error("UIA unavailable"))
      .mockReturnValue(late.promise);
    const present = vi.fn();
    const patch = vi.fn();
    const launcher = new SelectionLauncher({ target: async () => 0, read, present, patch });
    await launcher.open();
    await launcher.open();
    expect(present.mock.calls.map(([text]) => text)).toEqual(["", ""]);
    expect(patch.mock.calls.map(([text]) => text)).toEqual(["old selection"]);
    const pending = launcher.open();
    launcher.cancel();
    late.resolve("late selection");
    await pending;
    expect(patch).toHaveBeenCalledTimes(1);
    launcher.stop();
    await launcher.open();
    // Cancelling before the target resolves skips the read entirely.
    expect(read).toHaveBeenCalledTimes(2);
  });
});
