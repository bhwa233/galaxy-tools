import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTrustedNativeProcess,
  type NativeProcessExit,
  type PluginNativeController,
} from "../backend.js";
import { PluginResourceScope } from "../resources.js";
import { createOcrRuntime, type CaptureImage, type OcrResult } from "./capture.js";

vi.mock("../backend.js", () => ({ createTrustedNativeProcess: vi.fn() }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6o8AAAAASUVORK5CYII=",
  "base64",
);

// Reuse CaptureController's existing OS seam. The fixture supplies only the
// worker's ready/exit and individual reply files, not a second worker loop or
// OCR implementation. All session, resource and retention logic stays real.
async function fixture() {
  vi.useFakeTimers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-ocr-runtime-"));
  const pluginRoot = path.join(root, "plugin"),
    dataDir = path.join(root, "data"),
    cacheDir = path.join(root, "cache");
  fs.mkdirSync(pluginRoot);
  const executable = path.join(pluginRoot, "reader.exe"),
    input = path.join(root, "source.png");
  fs.writeFileSync(executable, "Owned transport fixture; never executed");
  fs.writeFileSync(input, png);
  const owner = { pluginId: "fixture.ocr", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const exit = Promise.withResolvers<NativeProcessExit>();
  const images = new Map<string, CaptureImage>(),
    results: OcrResult[] = [];
  const pid = 42599,
    requestId = randomUUID();
  let directory = "",
    workerId = "",
    processed = 0,
    ended = false;
  let finishExit = () => {};
  vi.mocked(createTrustedNativeProcess).mockImplementationOnce(async (options) => {
    const arg = (name: string) =>
      options.descriptor.args.find((x) => x.startsWith(name + "="))!.slice(name.length + 1);
    directory = arg("--spark233-session-dir");
    workerId = arg("--spark233-session");
    finishExit = () => {
      if (ended) return;
      ended = true;
      const result = { owner, requestId, code: 0, signal: null };
      options.onExit?.(result);
      exit.resolve(result);
    };
    const controller: PluginNativeController = {
      owner,
      requestId,
      pid,
      prepareStop: async () => ({ ok: true }),
      waitForExit: () => exit.promise,
      dispose: async () => {
        await options.requestShutdown?.();
        finishExit();
      },
    };
    options.scope.own("process", {
      prepareStop: controller.prepareStop,
      dispose: controller.dispose,
    });
    fs.writeFileSync(
      path.join(directory, "worker.json"),
      JSON.stringify({
        protocol: 1,
        kind: "ocr-worker",
        sessionId: workerId,
        pid,
        engineInitializations: 1,
      }),
    );
    return controller;
  });
  const runtime = await createOcrRuntime({
    scope,
    pluginRoot,
    descriptor: { path: executable, args: [] },
    dataDir,
    cacheDir,
    approveTrust: () => true,
    timeoutMs: 40,
    idleTimeoutMs: 1000,
    resolveImage: (resource) => {
      if (resource.id !== "owned-input") throw Error("Unknown source");
      return input;
    },
    onImage: (image) => {
      images.set(image.resource.id, image);
    },
    onImageReleased: (image) => {
      images.delete(image.resource.id);
    },
    onResult: (result) => {
      // Publication must follow both durable writes and resource registration.
      expect(images.has(result.source.id)).toBe(true);
      expect(fs.readFileSync(images.get(result.source.id)!.path)).toEqual(png);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(dataDir, "results", result.sessionId + ".json"), "utf8"),
        ),
      ).toEqual(result);
      results.push(result);
    },
  });
  cleanups.push(async () => {
    finishExit();
    await vi.advanceTimersByTimeAsync(100);
    await scope.stop("crash");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = () => {
    const pending = runtime.activate({
      commandId: "ocr",
      context: { kind: "image", resource: { id: "owned-input", kind: "image" } },
    });
    void pending.catch(() => {});
    return pending;
  };
  const request = async () => {
    await vi.advanceTimersByTimeAsync(20);
    const value = JSON.parse(fs.readFileSync(path.join(directory, "request.json"), "utf8")) as {
      sessionId: string;
      workerSessionId: string;
      pid: number;
    };
    fs.unlinkSync(path.join(directory, "request.json"));
    return value;
  };
  const reply = (sessionId: string, text: string) => {
    const task = path.join(cacheDir, "sessions", sessionId);
    fs.writeFileSync(
      path.join(task, "worker-proof.json"),
      JSON.stringify({
        protocol: 1,
        sessionId,
        pid,
        workerSessionId: workerId,
        engineInitializations: 1,
        processed: ++processed,
      }),
    );
    fs.writeFileSync(
      path.join(task, "ocr.json"),
      JSON.stringify({
        protocol: 1,
        kind: "ocr",
        sessionId,
        pid,
        width: 1,
        height: 1,
        text,
        detectionMs: 1,
        recognitionMs: 2,
        lines: [
          {
            text,
            score: 1,
            box: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          },
        ],
      }),
    );
  };
  return {
    runtime,
    scope,
    input,
    images,
    results,
    cacheDir,
    dataDir,
    start,
    request,
    reply,
    close: () => finishExit(),
    get directory() {
      return directory;
    },
  };
}

describe("OCR worker session and resource ownership", () => {
  it("publishes durable OCR-owned images and reuses its warm worker for a subsequent task", async () => {
    const f = await fixture();
    const first = f.start(),
      requestA = await f.request();
    f.reply(requestA.sessionId, "First owned text");
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toMatchObject({ text: "First owned text" });
    const firstResult = f.results[0],
      firstImage = f.images.get(firstResult.source.id)!;
    expect(firstImage.owner).toEqual(f.scope.owner);
    expect(firstImage.path).not.toBe(f.input);
    fs.rmSync(f.input);
    expect(fs.readFileSync(firstImage.path)).toEqual(png);

    fs.writeFileSync(f.input, png);
    const second = f.start(),
      requestB = await f.request();
    expect(requestB.workerSessionId).toBe(requestA.workerSessionId);
    expect(requestB.pid).toBe(requestA.pid);
    expect(requestB.sessionId).not.toBe(requestA.sessionId);
    f.reply(requestB.sessionId, "Second owned text");
    await vi.advanceTimersByTimeAsync(20);
    await expect(second).resolves.toMatchObject({ text: "Second owned text" });
    expect(createTrustedNativeProcess).toHaveBeenCalledOnce();
    expect(f.results[1].source.id).not.toBe(firstResult.source.id);
    expect(fs.readFileSync(firstImage.path)).toEqual(png);
    expect(fs.readdirSync(path.join(f.cacheDir, "sessions"))).toEqual([]);
    await expect(f.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it("retains an unexited cancelled worker and suppresses late output when it finally exits", async () => {
    const f = await fixture();
    const pending = f.start(),
      request = await f.request();
    const rejected = expect(pending).rejects.toThrow(/cancelled|exited/);
    const cancel = f.runtime.cancel();
    await vi.advanceTimersByTimeAsync(50);
    await expect(cancel).resolves.toMatchObject({ ok: false });
    expect(f.runtime.activeSession).toBe(request.sessionId);
    expect(fs.existsSync(f.directory)).toBe(true);
    expect(fs.existsSync(path.join(f.directory, "cancel.request"))).toBe(true);
    expect(f.results).toEqual([]);
    f.reply(request.sessionId, "Late text must not be published");
    f.close();
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(f.results).toEqual([]);
    expect(f.images.size).toBe(0);
    expect(f.runtime.activeSession).toBeUndefined();
    expect(fs.existsSync(path.join(f.cacheDir, "sessions", request.sessionId))).toBe(false);
    expect(fs.existsSync(f.directory)).toBe(false);
    await expect(f.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
  });
});
