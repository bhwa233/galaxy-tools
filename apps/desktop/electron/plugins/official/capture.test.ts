import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTrustedNativeProcess,
  type NativeProcessExit,
  type PluginNativeController,
  type TrustedNativeOptions,
} from "../backend.js";
import { PluginResourceScope } from "../resources.js";
import { createCaptureRuntime } from "./capture.js";

vi.mock("../backend.js", () => ({ createTrustedNativeProcess: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("follows OCR off/on/off within one capture session and rechecks availability before dispatch", async () => {
  // Regression: an initial --spark233-ocr-enabled=false permanently blocked
  // re-enabling the native action even after the host removed ocr.disabled.
  // Reuse the real CaptureController/session files; only its OS process boundary
  // is controlled. No native UI or duplicate native ocrAllowed implementation.
  vi.useFakeTimers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-capture-availability-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin"),
    executable = path.join(pluginRoot, "capture.exe");
  fs.mkdirSync(pluginRoot);
  fs.writeFileSync(executable, "Owned process-boundary fixture; never executed");
  const owner = { pluginId: "fixture.capture", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const started = Promise.withResolvers<TrustedNativeOptions>();
  const exited = Promise.withResolvers<NativeProcessExit>();
  const pid = 42501,
    requestId = randomUUID();
  const controller: PluginNativeController = {
    owner,
    requestId,
    pid,
    prepareStop: async () => ({ ok: true }),
    waitForExit: () => exited.promise,
    dispose: async () => {},
  };
  vi.mocked(createTrustedNativeProcess).mockImplementationOnce(async (options) => {
    options.scope.own("process", {
      prepareStop: controller.prepareStop,
      dispose: controller.dispose,
    });
    started.resolve(options);
    return controller;
  });
  let available = false;
  const getOcrStatus = vi.fn(() => ({ available, reason: "OCR fixture disabled" }));
  const recognize = vi.fn(async () => ({ recognized: true }));
  const onResult = vi.fn();
  const runtime = await createCaptureRuntime({
    scope,
    pluginRoot,
    descriptor: { path: executable, args: [] },
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    approveTrust: () => true,
    getOcrStatus,
    recognize,
    onResult,
  });
  const pending = runtime.activate({ commandId: "capture" });
  const options = await started.promise;
  const sessionId = runtime.activeSession!;
  const directory = path.join(root, "cache", "sessions", sessionId);
  const disabled = path.join(directory, "ocr.disabled");
  expect(fs.readFileSync(disabled, "utf8")).toBe("OCR fixture disabled");
  expect(options.descriptor.args).not.toContain("--spark233-ocr-enabled=false");

  available = true;
  await vi.advanceTimersByTimeAsync(250);
  expect(fs.existsSync(disabled)).toBe(false);
  expect(runtime.activeSession).toBe(sessionId);
  available = false;
  await vi.advanceTimersByTimeAsync(250);
  expect(fs.existsSync(disabled)).toBe(true);

  // Publish a real bounded PNG/session result at the controlled process exit.
  // The production adapter reads the image and must reject the final OCR hop.
  fs.writeFileSync(
    path.join(directory, "selection.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6o8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  fs.writeFileSync(
    path.join(directory, "capture.json"),
    JSON.stringify({
      protocol: 1,
      sessionId,
      pid,
      kind: "capture",
      action: "ocr",
      image: "selection.png",
      width: 1,
      height: 1,
    }),
  );
  exited.resolve({ owner, requestId, code: 0, signal: null });
  await expect(pending).resolves.toMatchObject({
    status: "ocr-unavailable",
    reason: "OCR fixture disabled",
  });
  expect(onResult).toHaveBeenCalledOnce();
  expect(recognize).not.toHaveBeenCalled();
  expect(runtime.activeSession).toBeUndefined();
  expect(fs.existsSync(directory)).toBe(false);
  expect(getOcrStatus).toHaveBeenCalled();
  await expect(scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
});
