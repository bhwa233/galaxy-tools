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
import { createCaptureRuntime, type CaptureRuntimeOptions } from "./capture.js";

vi.mock("../backend.js", () => ({ createTrustedNativeProcess: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const pinPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6o8AAAAASUVORK5CYII=",
  "base64",
);
function controlledPinCapture(pid: number) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "spark233-capture-pin-")),
  );
  roots.push(root);
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(pluginRoot);
  const executable = path.join(pluginRoot, "capture.exe");
  fs.writeFileSync(executable, "Owned process-boundary fixture; never executed");
  const owner = { pluginId: "fixture.capture", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const started = Promise.withResolvers<TrustedNativeOptions>();
  const exited = Promise.withResolvers<NativeProcessExit>();
  const requestId = randomUUID();
  const controller: PluginNativeController = {
    owner,
    requestId,
    pid,
    prepareStop: async () => ({ ok: true }),
    waitForExit: () => exited.promise,
    dispose: async () => {},
  };
  vi.mocked(createTrustedNativeProcess).mockImplementationOnce(async (options) => {
    options.scope.own("process", controller);
    started.resolve(options);
    return controller;
  });
  const options: CaptureRuntimeOptions = {
    scope,
    pluginRoot,
    descriptor: { path: executable, args: [] },
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    approveTrust: () => true,
    getOcrStatus: () => ({ available: false }),
    canPinToDesktop: () => true,
  };
  return {
    root,
    scope,
    started,
    options,
    exit: () => exited.resolve({ owner, requestId, code: 0, signal: null }),
    pin: (sessionId: string, attempt: number) => {
      const directory = path.join(options.cacheDir, "sessions", sessionId);
      for (const name of ["pin.png", "pin-source.png"])
        fs.writeFileSync(path.join(directory, name), pinPng);
      fs.writeFileSync(path.join(directory, "pin-document.json"), '{"version":1,"items":[]}');
      return {
        directory,
        envelope: {
          protocol: 1,
          sessionId,
          pid,
          kind: "pin",
          action: "pin",
          attempt,
          image: "pin.png",
          source: "pin-source.png",
          document: "pin-document.json",
          width: 1,
          height: 1,
          bounds: { x: -120, y: 40, width: 1, height: 1 },
          scale: 1,
        },
      };
    },
  };
}

it("follows OCR off/on/off within one capture session and rechecks availability before dispatch", async () => {
  // Regression: an initial --spark233-ocr-enabled=false permanently blocked
  // re-enabling the native action even after the host removed ocr.disabled.
  // Reuse the real CaptureController/session files; only its OS process boundary
  // is controlled. No native UI or duplicate native ocrAllowed implementation.
  vi.useFakeTimers();
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "spark233-capture-availability-")),
  );
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

it("records a plain copy in history and never forwards it to OCR", async () => {
  // Copy, save and pin complete without OCR; only the OCR action may open a text
  // pane. History must still hold the image the user copied.
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "spark233-capture-history-copy-")),
  );
  roots.push(root);
  const pluginRoot = path.join(root, "plugin"),
    executable = path.join(pluginRoot, "capture.exe");
  fs.mkdirSync(pluginRoot);
  fs.writeFileSync(executable, "Owned process-boundary fixture; never executed");
  const owner = { pluginId: "fixture.capture", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const started = Promise.withResolvers<TrustedNativeOptions>();
  const exited = Promise.withResolvers<NativeProcessExit>();
  const pid = 42502,
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
  const recognize = vi.fn(async () => ({ recognized: true }));
  const onResult = vi.fn();
  const runtime = await createCaptureRuntime({
    scope,
    pluginRoot,
    descriptor: { path: executable, args: [] },
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    approveTrust: () => true,
    // OCR is enabled: the copy action must still stay out of it.
    getOcrStatus: () => ({ available: true }),
    recognize,
    onResult,
  });
  const pending = runtime.activate({ commandId: "capture" });
  await started.promise;
  const directory = path.join(root, "cache", "sessions", runtime.activeSession!);
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
      sessionId: runtime.activeSession,
      pid,
      kind: "capture",
      action: "copy",
      image: "selection.png",
      width: 1,
      height: 1,
    }),
  );
  exited.resolve({ owner, requestId, code: 0, signal: null });
  await expect(pending).resolves.toMatchObject({ status: "copy" });
  expect(recognize).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ width: 1, height: 1 }), "copy");
  const images = fs.readdirSync(path.join(root, "data", "history", "images"));
  expect(images).toHaveLength(1);
  await expect(scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
});

it("accepts one owned pin attempt only after durable publication and rejects forged identities and paths", async () => {
  // The native editor must keep its editable session until the host's actual
  // publication completes. A file alone is not an acknowledgement or authority.
  vi.useFakeTimers();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = controlledPinCapture(42503);
  const published = Promise.withResolvers<string>();
  const onPin = vi.fn<NonNullable<CaptureRuntimeOptions["onPin"]>>(() => published.promise);
  const onPinAcknowledged = vi.fn(async () => {
    throw new Error("Old-revision GC fixture failed after acknowledgement");
  });
  const onPinAborted = vi.fn(async () => {});
  const onResult = vi.fn();
  const runtime = await createCaptureRuntime({
    ...fixture.options,
    onPin,
    onPinAcknowledged,
    onPinAborted,
    onResult,
  });
  const pending = runtime.activate({ commandId: "capture" });
  const started = await fixture.started.promise;
  expect(started.descriptor.args).toContain("--spark233-pin-host=true");
  const sessionId = runtime.activeSession!;
  const { directory, envelope } = fixture.pin(sessionId, 1);
  const request = path.join(directory, "pin.json"),
    ack = path.join(directory, "pin.ack");
  fs.writeFileSync(request, JSON.stringify({ ...envelope, pid: envelope.pid + 1 }));
  await vi.advanceTimersByTimeAsync(100);
  expect(onPin).not.toHaveBeenCalled();
  expect(fs.existsSync(ack)).toBe(false);
  fs.writeFileSync(request, JSON.stringify({ ...envelope, image: "../outside.png" }));
  await vi.advanceTimersByTimeAsync(100);
  expect(onPin).not.toHaveBeenCalled();
  expect(fs.readFileSync(ack, "utf8")).toBe(`${sessionId}:42503:1:rejected`);
  fs.writeFileSync(request, JSON.stringify({ ...envelope, attempt: 2 }));
  await vi.advanceTimersByTimeAsync(100);
  expect(onPin).toHaveBeenCalledOnce();
  expect(fs.readFileSync(ack, "utf8")).toBe(`${sessionId}:42503:1:rejected`);
  await vi.advanceTimersByTimeAsync(300);
  expect(onPin).toHaveBeenCalledOnce();
  // A real filesystem refusal of the ACK must retry that ACK, not publish a
  // second pin or retract the already committed image.
  fs.unlinkSync(ack);
  fs.mkdirSync(ack);
  const pinId = randomUUID();
  published.resolve(pinId);
  await vi.advanceTimersByTimeAsync(0);
  expect(fs.statSync(ack).isDirectory()).toBe(true);
  expect(onPin).toHaveBeenCalledOnce();
  expect(onPinAcknowledged).not.toHaveBeenCalled();
  fs.rmdirSync(ack);
  await vi.advanceTimersByTimeAsync(100);
  expect(fs.readFileSync(ack, "utf8")).toBe(`${sessionId}:42503:2:accepted`);
  expect(onPinAcknowledged).toHaveBeenCalledWith(pinId);
  expect(onPinAborted).not.toHaveBeenCalled();
  fixture.exit();
  await expect(pending).resolves.toEqual({ status: "pinned", pinId });
  expect(onResult).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(fixture.options.dataDir, "history", "index.json"))).toBe(false);
  expect(fs.existsSync(directory)).toBe(false);
  await expect(fixture.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
  logged.mockRestore();
});

it("copies trusted editable inputs and rolls back a publication cancelled before native acknowledgement", async () => {
  vi.useFakeTimers();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = controlledPinCapture(42504);
  const published = Promise.withResolvers<string>();
  const onPin = vi.fn<NonNullable<CaptureRuntimeOptions["onPin"]>>(() => published.promise);
  const onPinAborted = vi.fn(async () => {});
  for (let i = 0; i < 3; i++)
    onPinAborted.mockRejectedValueOnce(
      new Error("Publication rollback fixture is temporarily blocked"),
    );
  const onPinAcknowledged = vi.fn(async () => {});
  const runtime = await createCaptureRuntime({
    ...fixture.options,
    onPin,
    onPinAborted,
    onPinAcknowledged,
  });
  await expect(
    runtime.editPin({ sourcePath: "relative.png", documentPath: "relative.json" }),
  ).rejects.toThrow(/absolute/);
  expect(runtime.activeSession).toBeUndefined();
  const sourcePath = path.join(fixture.root, "trusted-source.png"),
    documentPath = path.join(fixture.root, "trusted-document.json"),
    bounds = { x: -120, y: 40, width: 1, height: 1 };
  fs.writeFileSync(sourcePath, pinPng);
  fs.writeFileSync(documentPath, '{"version":1,"items":[]}');
  const pending = runtime.editPin({ sourcePath, documentPath, bounds });
  const rejected = expect(pending).rejects.toThrow(/rollback fixture/);
  const started = await fixture.started.promise;
  expect(started.descriptor.args).toContain("--spark233-edit-pin=true");
  expect(started.descriptor.args.join(" ")).not.toContain(sourcePath);
  const sessionId = runtime.activeSession!;
  const { directory, envelope } = fixture.pin(sessionId, 1);
  expect(fs.readFileSync(path.join(directory, "edit-source.png"))).toEqual(pinPng);
  expect(JSON.parse(fs.readFileSync(path.join(directory, "edit-bounds.json"), "utf8"))).toEqual(
    bounds,
  );
  fs.writeFileSync(path.join(directory, "pin.json"), JSON.stringify(envelope));
  await vi.advanceTimersByTimeAsync(100);
  expect(onPin).toHaveBeenCalledOnce();
  const isCurrent = onPin.mock.calls[0][1];
  expect(isCurrent()).toBe(true);
  const cancelled = runtime.cancel();
  expect(isCurrent()).toBe(false);
  fixture.exit();
  const pinId = randomUUID();
  published.resolve(pinId);
  await rejected;
  expect(runtime.activeSession).toBe(sessionId);
  await expect(runtime.cancel()).resolves.toEqual({ ok: true });
  await expect(cancelled).resolves.toEqual({ ok: true });
  expect(onPinAborted).toHaveBeenCalledWith(pinId);
  expect(onPinAcknowledged).not.toHaveBeenCalled();
  expect(fs.existsSync(directory)).toBe(false);
  await expect(fixture.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
  logged.mockRestore();
});
