import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSelectionReader } from "./selection-native.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

class Helper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: Array<{ id: string; operation: string }> = [];
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit("close", 0));
    return true;
  });

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.requests.push(JSON.parse(String(chunk))));
    this.stdin.on("finish", () => queueMicrotask(() => this.emit("close", 0)));
    queueMicrotask(() => this.stdout.write(JSON.stringify({ ready: true }) + "\n"));
  }
  reply(text: string) {
    this.stdout.write(JSON.stringify({ id: this.requests.at(-1)!.id, text }) + "\n");
  }
}

const helpers: Helper[] = [];
let reader: NativeSelectionReader;
beforeEach(() => {
  vi.mocked(spawn).mockImplementation(() => {
    const helper = new Helper();
    helpers.push(helper);
    return helper as unknown as ReturnType<typeof spawn>;
  });
  reader = new NativeSelectionReader({ assetDirectory: "unused", cacheDirectory: "unused" });
  vi.spyOn(reader as unknown as { compile(): Promise<string> }, "compile").mockResolvedValue(
    "helper.exe",
  );
});
afterEach(async () => {
  await reader.stop();
  helpers.length = 0;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe.skipIf(process.platform !== "win32")("resident selection transport", () => {
  it("prepares once and reuses the helper for consecutive selections", async () => {
    await reader.prepare();
    for (const [index, text] of ["first", "second"].entries()) {
      const result = reader.read(new AbortController().signal);
      await vi.waitFor(() => expect(helpers[0].requests.length).toBe(index + 1));
      helpers[0].reply(text);
      await expect(result).resolves.toBe(text);
    }
    expect(spawn).toHaveBeenCalledOnce();
    expect(helpers[0].kill).not.toHaveBeenCalled();
  });

  it("isolates a cancelled read so its late result cannot satisfy the next request", async () => {
    const firstSignal = new AbortController();
    const first = reader.read(firstSignal.signal);
    await vi.waitFor(() => expect(helpers[0]?.requests.length).toBe(1));
    const old = helpers[0];
    firstSignal.abort();
    await expect(first).resolves.toBe("");
    const second = reader.read(new AbortController().signal);
    await vi.waitFor(() => expect(helpers[1]?.requests.length).toBe(1));
    old.reply("stale");
    helpers[1].reply("current");
    await expect(second).resolves.toBe("current");
    expect(old.kill).toHaveBeenCalledOnce();
  });

  it("recovers from a hung read and resolves pending work when stopped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await reader.prepare();
    const hung = reader.read(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(hung).resolves.toBe("");
    expect(helpers[0].kill).toHaveBeenCalledOnce();
    const next = reader.read(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await reader.stop();
    await expect(next).resolves.toBe("");
    const count = helpers.length;
    await expect(reader.read(new AbortController().signal)).resolves.toBe("");
    expect(helpers).toHaveLength(count);
  });
});
