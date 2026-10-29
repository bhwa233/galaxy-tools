import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createClipboardRuntime } from "./clipboard.js";
import { PluginResourceScope } from "../resources.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

it("captures targets ahead of history writes and rejects queued or late target changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-target-"));
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(pluginRoot);
  const executable = path.join(pluginRoot, "helper.exe");
  fs.writeFileSync(executable, "inert transport fixture");
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let sessionId = "";
  let delayRemember = false;
  let late: { id: string; operation: string } | undefined;
  const native: string[] = [];
  const reply = (id: string) =>
    child.stdout.write(
      JSON.stringify({ protocol: 1, sessionId, type: "response", id, ok: true }) + "\n",
    );
  vi.mocked(spawn).mockImplementation((_file, args) => {
    sessionId = (args as string[])
      .find((arg) => arg.startsWith("--spark233-session="))!
      .split("=")[1];
    queueMicrotask(() =>
      child.stdout.write(
        JSON.stringify({
          protocol: 1,
          sessionId,
          type: "ready",
          pid: child.pid,
          station: "fixture",
        }) + "\n",
      ),
    );
    return child as unknown as ReturnType<typeof spawn>;
  });
  child.stdin.on("data", (bytes) => {
    const request = JSON.parse(String(bytes));
    native.push(request.operation);
    if (delayRemember && request.operation === "remember") {
      late = request;
      return;
    }
    reply(request.id);
    if (request.operation === "stop") queueMicrotask(() => child.emit("close", 0));
  });
  let releaseHistory!: () => void;
  const history = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const activate = vi.fn(async ({ parameters }: { parameters?: unknown }) => {
    const input = parameters as { action: string; file?: string };
    if (input.action === "settings")
      return { paused: false, excludedApps: [], compactPosition: "cursor" };
    if (input.action === "list") {
      await history;
      return {};
    }
    if (input.action === "snapshot") {
      fs.writeFileSync(input.file!, "snapshot");
      return { file: input.file, bytes: 8 };
    }
    return {};
  });
  const runtime = await createClipboardRuntime({
    scope: new PluginResourceScope({
      pluginId: "spark233.clipboard",
      version: "0.1.3",
      instanceId: "target-fixture",
    }),
    pluginRoot,
    descriptor: { path: executable, args: [] },
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    approveTrust: () => true,
    backend: {
      activate: activate as never,
      maintenance: activate as never,
      prepareStop: async () => ({ ok: true }),
      running: true,
    },
  });
  try {
    const writing = runtime.request({ action: "list" });
    await runtime.rememberTarget();
    expect(native).toContain("remember");
    const obsoletePaste = runtime.request({ action: "paste", id: "sample" });
    const rejectedPaste = expect(obsoletePaste).rejects.toThrow(/粘贴目标/);
    await runtime.rememberTarget();
    releaseHistory();
    await writing;
    await rejectedPaste;
    expect(native).not.toContain("paste");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    delayRemember = true;
    const timeout = expect(runtime.rememberTarget()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(150);
    await timeout;
    reply(late!.id);
    await expect(runtime.request({ action: "paste", id: "sample" })).rejects.toThrow(/粘贴目标/);
    delayRemember = false;
    await runtime.rememberTarget();
    await expect(runtime.request({ action: "paste", id: "sample" })).resolves.toEqual({
      copied: true,
      pasted: true,
    });
  } finally {
    releaseHistory();
    vi.useRealTimers();
    await runtime.dispose();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
