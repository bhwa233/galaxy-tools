import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  JsonValue,
  PluginActivation,
  PluginOwner,
  ResourceHandle,
  StopReason,
} from "@spark233/sdk";
import { atomicWrite, canonical, confined, inside } from "../../persistence.js";
import { createTrustedNativeProcess, type PluginNativeController } from "../backend.js";
import { PluginResourceScope, type StopDecision } from "../resources.js";

export interface CaptureImage {
  owner: PluginOwner;
  sessionId: string;
  resource: ResourceHandle;
  /** Trusted host-only path; never accepted from activation parameters. */
  path: string;
  width: number;
  height: number;
}
export interface OcrAvailability {
  available: boolean;
  reason?: string;
}
export interface CaptureRuntimeOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  descriptor: { path: string; args: string[] };
  dataDir: string;
  cacheDir: string;
  approveTrust: () => boolean | Promise<boolean>;
  onOutputBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  /** Sampled when opening and immediately before forwarding a selected image. */
  getOcrStatus: () => OcrAvailability;
  getLocale?: () => string;
  recognize?: (image: CaptureImage) => Promise<JsonValue | undefined>;
  onResult?: (image: CaptureImage) => void | Promise<void>;
  /** Graceful cancellation deadline, not a deadline for user annotation work. */
  timeoutMs?: number;
}
export interface OcrRuntimeOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  descriptor: { path: string; args: string[] };
  dataDir: string;
  cacheDir: string;
  approveTrust: () => boolean | Promise<boolean>;
  onOutputBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  /** Host resource resolver must enforce the resource's ownership and lifetime. */
  resolveImage: (resource: ResourceHandle) => string | Promise<string>;
  /** Register only OCR-owned durable output, after both image and result save. */
  onImage?: (image: CaptureImage) => void | Promise<void>;
  /** Revoke a retired output or a consumed input copied into the OCR data domain. */
  onImageReleased?: (image: CaptureImage) => void | Promise<void>;
  onResult?: (result: OcrResult) => void | Promise<void>;
  timeoutMs?: number;
  /** Host policy; a warm engine is released after this much idle time. */
  idleTimeoutMs?: number;
}
export interface OcrResult {
  owner: PluginOwner;
  sessionId: string;
  source: ResourceHandle;
  width: number;
  height: number;
  text: string;
  detectionMs: number;
  recognitionMs: number;
  lines: Array<{ text: string; score: number; box: number[][] }>;
}
export interface CaptureRuntime {
  readonly owner: PluginOwner;
  readonly activeSession: string | undefined;
  activate(activation: PluginActivation): Promise<JsonValue | undefined>;
  cancel(): Promise<StopDecision>;
  prepareStop(reason: StopReason): Promise<StopDecision>;
  dispose(): Promise<void>;
}
export interface OcrRuntime extends CaptureRuntime {
  recognize(image: CaptureImage): Promise<JsonValue | undefined>;
}

const envelope = z.object({
  protocol: z.literal(1),
  sessionId: z.string(),
  pid: z.number().int().positive(),
  width: z.number().int().positive().max(65536),
  height: z.number().int().positive().max(65536),
});
const captureResult = envelope.extend({
  kind: z.literal("capture"),
  action: z.literal("ocr"),
  image: z.literal("selection.png"),
});
const ocrResult = envelope.extend({
  kind: z.literal("ocr"),
  text: z.string().max(4 * 1024 * 1024),
  detectionMs: z.number().finite().nonnegative(),
  recognitionMs: z.number().finite().nonnegative(),
  lines: z
    .array(
      z.object({
        text: z.string(),
        score: z.number().finite(),
        box: z.array(z.array(z.number().finite()).length(2)).length(4),
      }),
    )
    .max(50000),
});
const resource = z.object({
  id: z.string().min(1).max(512),
  kind: z.literal("image"),
  mimeType: z.string().optional(),
  size: z.number().nonnegative().optional(),
});

interface NativeSession {
  id: string;
  directory: string;
  scope: PluginResourceScope;
  process?: PluginNativeController;
  cancelled: boolean;
  done: Promise<void>;
  finish: () => void;
}

// The existing trusted process controller owns spawn/trust/exit tracking. This
// adapter supplies the selected tools' session files and cooperative shutdown.
class CaptureController implements CaptureRuntime {
  readonly owner: PluginOwner;
  protected current?: NativeSession;
  protected disposed = false;
  protected readonly root: string;
  constructor(
    protected readonly options: CaptureRuntimeOptions | OcrRuntimeOptions,
    protected readonly kind: "capture" | "ocr",
  ) {
    this.owner = options.scope.owner;
    this.root = canonical(options.pluginRoot);
    const executable = fs.realpathSync(options.descriptor.path);
    if (
      !path.isAbsolute(options.pluginRoot) ||
      !path.isAbsolute(options.descriptor.path) ||
      !inside(this.root, executable) ||
      !fs.statSync(executable).isFile() ||
      !/\.exe$/i.test(executable)
    )
      throw new Error("Official native entry must be inside its validated package");
    if (
      options.descriptor.args.some((argument) =>
        /(?:spark233|image-path|auto-quit|--enter)/i.test(argument),
      )
    )
      throw new Error("Official session arguments are controlled by the host");
    for (const directory of [options.dataDir, options.cacheDir]) {
      if (!path.isAbsolute(directory)) throw new Error("Plugin data/cache paths must be absolute");
      fs.mkdirSync(directory, { recursive: true });
      if (inside(this.root, canonical(directory)))
        throw new Error("Plugin mutable data cannot be inside its immutable package");
    }
    options.scope.own("task", {
      prepareStop: (reason) => this.prepareStop(reason),
      dispose: () => this.dispose(),
    });
  }
  get activeSession(): string | undefined {
    return this.current?.id;
  }
  protected assertActive(): void {
    if (this.disposed || this.options.scope.state !== "active")
      throw new Error("Plugin is not accepting native tasks");
    if (this.current)
      throw new Error("A native task is already running; finish or cancel it first");
  }
  protected createSession(): NativeSession {
    this.assertActive();
    const id = randomUUID().replaceAll("-", "");
    const directory = confined(this.options.cacheDir, `sessions/${id}`);
    fs.mkdirSync(directory, { recursive: true });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = {
      id,
      directory,
      scope: new PluginResourceScope(this.owner),
      cancelled: false,
      done,
      finish,
    };
    atomicWrite(
      confined(directory, "owner.json"),
      JSON.stringify({ protocol: 1, owner: this.owner, sessionId: id }),
    );
    this.current = session;
    if (this.kind === "capture") {
      const locale = (this.options as CaptureRuntimeOptions)
        .getLocale?.()
        .toLowerCase()
        .startsWith("en")
        ? "en-US"
        : "zh-CN";
      atomicWrite(
        confined(directory, "config.json"),
        JSON.stringify({
          common: { autoStart: false, language: locale },
          shortcutKey: { cap: "" },
        }),
      );
    }
    return session;
  }
  protected requestCancellation(session: NativeSession): void {
    session.cancelled = true;
    if (session.process?.pid)
      atomicWrite(
        confined(session.directory, "cancel.request"),
        `${session.id}:${session.process.pid}:cancel`,
      );
  }
  async cancel(): Promise<StopDecision> {
    const session = this.current;
    if (!session) return { ok: true };
    this.requestCancellation(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      session.done.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.options.timeoutMs ?? 15000);
      }),
    ]);
    clearTimeout(timer);
    return exited
      ? { ok: true }
      : { ok: false, reason: "Native cancellation is still pending; the process remains tracked" };
  }
  async prepareStop(_reason: StopReason): Promise<StopDecision> {
    if (this.current && this.kind === "capture")
      return {
        ok: false,
        reason: "Finish or cancel the active screenshot before stopping or updating its plugin",
      };
    return this.cancel();
  }
  async dispose(): Promise<void> {
    if (this.current)
      throw new Error("Native task must finish before plugin resources are released");
    this.disposed = true;
  }
  protected async start(session: NativeSession, args: string[]): Promise<void> {
    const process = await createTrustedNativeProcess({
      scope: session.scope,
      pluginRoot: this.root,
      descriptor: {
        path: this.options.descriptor.path,
        args: [
          ...this.options.descriptor.args,
          `--spark233-session=${session.id}`,
          `--spark233-session-dir=${session.directory}`,
          ...args,
        ],
      },
      approveTrust: this.options.approveTrust,
      onOutputBytes: this.options.onOutputBytes,
      prepareStop: () => ({ ok: true }),
      requestShutdown: () => this.requestCancellation(session),
      timeoutMs: this.options.timeoutMs ?? 15000,
    });
    session.process = process;
    if (session.cancelled) this.requestCancellation(session);
    const exit = await process.waitForExit();
    const cancellationFile = confined(session.directory, "cancel.json");
    const cancellation = fs.existsSync(cancellationFile)
      ? z
          .object({
            protocol: z.literal(1),
            sessionId: z.literal(session.id),
            pid: z.literal(process.pid),
            kind: z.literal("cancelled"),
            action: z.literal("cancel"),
          })
          .parse(JSON.parse(fs.readFileSync(cancellationFile, "utf8")))
      : undefined;
    atomicWrite(
      confined(this.options.dataDir, `sessions/${session.id}.json`),
      JSON.stringify({
        ...exit,
        pid: process.pid,
        sessionId: session.id,
        cancelled: session.cancelled,
        cancellationAcknowledged: !!cancellation,
      }),
    );
    if (exit.error || exit.code !== 0)
      throw new Error(exit.error ?? `Native task exited (${exit.code})`);
    if (session.cancelled || !this.options.scope.accepts(this.owner))
      throw new Error("Native task cancelled; late output was discarded");
  }
  protected readResult<T>(session: NativeSession, name: string, schema: z.ZodType<T>): T {
    const filename = confined(session.directory, name);
    if (!fs.existsSync(filename)) throw new Error("Native task closed without a session result");
    if (fs.statSync(filename).size > 8 * 1024 * 1024)
      throw new Error("Native result exceeds 8 MiB");
    const value = schema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
    const identity = envelope.pick({ protocol: true, sessionId: true, pid: true }).parse(value);
    if (identity.sessionId !== session.id || identity.pid !== session.process?.pid)
      throw new Error("Native result session/PID identity mismatch");
    return value;
  }
  protected async finishSession(session: NativeSession): Promise<void> {
    const released = await session.scope.stop("quit");
    if (!released.ok) throw new Error(released.errors.join("; "));
    try {
      // Completed output has already been copied to private durable data. No
      // screenshot remains in the per-task cache after normal exit/cancellation.
      fs.rmSync(session.directory, { recursive: true, force: true });
    } finally {
      if (this.current === session) this.current = undefined;
      session.finish();
    }
  }
  async activate(activation: PluginActivation): Promise<JsonValue | undefined> {
    if (activation.commandId === "cancel") return (await this.cancel()) as unknown as JsonValue;
    if (activation.commandId && !["capture", "ocr"].includes(activation.commandId))
      throw new Error("Unknown screenshot command");
    const options = this.options as CaptureRuntimeOptions;
    if (activation.commandId === "ocr" && (!options.getOcrStatus().available || !options.recognize))
      throw new Error(
        options.getOcrStatus().reason ??
          "OCR plugin is unavailable; basic screenshot remains available",
      );
    const session = this.createSession();
    const disabledFile = confined(session.directory, "ocr.disabled");
    const syncOcrStatus = () => {
      let availability: OcrAvailability;
      try {
        availability = options.getOcrStatus();
      } catch {
        availability = { available: false, reason: "OCR state is unavailable" };
      }
      if (!availability.available || !options.recognize)
        atomicWrite(disabledFile, availability.reason ?? "OCR plugin is disabled");
      else if (fs.existsSync(disabledFile)) fs.unlinkSync(disabledFile);
    };
    let availabilityTimer: ReturnType<typeof setInterval> | undefined;
    try {
      // The native session reads this file dynamically. A fixed false argv
      // would prevent an already-open selection from following a later enable.
      syncOcrStatus();
      availabilityTimer = setInterval(() => {
        try {
          syncOcrStatus();
        } catch (error) {
          clearInterval(availabilityTimer);
          console.error("capture-ocr-state", error);
        }
      }, 250);
      await this.start(session, [
        "--auto-quit=true",
        `--spark233-locale=${options.getLocale?.().toLowerCase().startsWith("en") ? "en-US" : "zh-CN"}`,
        ...(activation.commandId === "ocr" ? ["--enter=ocr"] : []),
      ]);
      // Basic copy/save/close may intentionally produce no OCR transfer.
      if (!fs.existsSync(confined(session.directory, "capture.json")))
        return { status: "closed", sessionId: session.id };
      const selected = this.readResult(session, "capture.json", captureResult);
      const png = checkedPng(confined(session.directory, selected.image));
      if (png.width !== selected.width || png.height !== selected.height)
        throw new Error("Selected PNG dimensions differ from native result");
      const imagePath = confined(options.dataDir, `images/${session.id}.png`);
      atomicWrite(imagePath, fs.readFileSync(png.path));
      const image: CaptureImage = {
        owner: this.owner,
        sessionId: session.id,
        path: imagePath,
        width: png.width,
        height: png.height,
        resource: {
          id: `${this.owner.pluginId}:${this.owner.instanceId}:${session.id}`,
          kind: "image",
          mimeType: "image/png",
          size: png.size,
        },
      };
      await options.onResult?.(image);
      if (!options.getOcrStatus().available || !options.recognize)
        return {
          status: "ocr-unavailable",
          image: image.resource as unknown as JsonValue,
          reason: options.getOcrStatus().reason ?? "OCR plugin is disabled",
        };
      return await options.recognize(image);
    } finally {
      clearInterval(availabilityTimer);
      await this.finishSession(session);
    }
  }
}

function checkedPng(filename: string): {
  path: string;
  size: number;
  width: number;
  height: number;
} {
  const real = fs.realpathSync(filename);
  const size = fs.statSync(real).size;
  if (size < 24 || size > 128 * 1024 * 1024)
    throw new Error("Image is not a supported PNG or exceeds 128 MiB");
  const descriptor = fs.openSync(real, "r");
  const header = Buffer.alloc(24);
  try {
    fs.readSync(descriptor, header, 0, 24, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (
    !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("OCR input must be a PNG image");
  const width = header.readUInt32BE(16),
    height = header.readUInt32BE(20);
  if (!width || !height || width > 65536 || height > 65536 || width * height > 100_000_000)
    throw new Error("OCR image dimensions exceed the task budget");
  return { path: real, size, width, height };
}

class OcrController extends CaptureController implements OcrRuntime {
  private readonly published: Array<{ image: CaptureImage; resultFile: string }> = [];
  private worker?: {
    id: string;
    directory: string;
    scope: PluginResourceScope;
    process: PluginNativeController;
    exited: boolean;
    ready: Promise<void>;
    exit: Promise<void>;
    closing?: Promise<void>;
    retiring?: boolean;
    failure?: Error;
  };
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly idleTimeoutMs: number;
  constructor(private readonly ocrOptions: OcrRuntimeOptions) {
    super(ocrOptions, "ocr");
    this.idleTimeoutMs = z
      .number()
      .int()
      .min(100)
      .max(300_000)
      .parse(ocrOptions.idleTimeoutMs ?? 30_000);
    ocrOptions.scope.own("process", {
      prepareStop: (reason) => this.prepareStop(reason),
      dispose: () => this.closeWorker(),
    });
    // This instance has no previous live workspace. Retire only generated OCR
    // output files, keeping picker inputs in the separate data/images domain.
    for (const [directory, suffix] of [
      [confined(ocrOptions.dataDir, "results"), ".json"],
      [confined(ocrOptions.dataDir, "results/images"), ".png"],
    ]) {
      fs.mkdirSync(directory, { recursive: true });
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (
          entry.isFile() &&
          /^(?:[\da-f]{32}|[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/i.test(
            path.basename(entry.name, suffix),
          ) &&
          entry.name.endsWith(suffix)
        )
          fs.rmSync(confined(directory, entry.name));
    }
  }
  private async getWorker() {
    clearTimeout(this.idleTimer);
    if (this.worker?.retiring || this.worker?.exited) await this.closeWorker();
    if (this.worker) {
      await this.worker.ready;
      return this.worker;
    }
    const id = randomUUID().replaceAll("-", "");
    const directory = confined(this.ocrOptions.cacheDir, `workers/${id}`);
    fs.mkdirSync(directory, { recursive: true });
    const scope = new PluginResourceScope(this.owner);
    let workerReference: NonNullable<OcrController["worker"]> | undefined;
    const process = await createTrustedNativeProcess({
      scope,
      pluginRoot: this.root,
      descriptor: {
        path: this.ocrOptions.descriptor.path,
        args: [
          ...this.ocrOptions.descriptor.args,
          `--spark233-session=${id}`,
          `--spark233-session-dir=${directory}`,
          "--spark233-worker=true",
          `--spark233-task-root=${confined(this.ocrOptions.cacheDir, "sessions")}`,
          `--spark233-worker-idle-ms=${this.idleTimeoutMs + 5000}`,
          `--spark233-host-pid=${globalThis.process.pid}`,
        ],
      },
      approveTrust: this.ocrOptions.approveTrust,
      onOutputBytes: this.ocrOptions.onOutputBytes,
      onExit: (exit) => {
        if ((exit.error || exit.code !== 0) && workerReference)
          workerReference.failure = new Error(exit.error ?? `OCR worker exited (${exit.code})`);
        atomicWrite(
          confined(this.ocrOptions.dataDir, `workers/${id}.json`),
          JSON.stringify({ ...exit, pid: workerReference?.process.pid, workerSessionId: id }),
        );
      },
      prepareStop: () => ({ ok: true }),
      requestShutdown: () => {
        atomicWrite(confined(directory, "cancel.request"), `${id}:${process.pid}:cancel`);
      },
      timeoutMs: this.ocrOptions.timeoutMs ?? 15_000,
    });
    const worker = {
      id,
      directory,
      scope,
      process,
      exited: false,
      ready: Promise.resolve(),
      exit: Promise.resolve(),
    } as NonNullable<OcrController["worker"]>;
    this.worker = worker;
    workerReference = worker;
    worker.exit = process
      .waitForExit()
      .then((exit) => {
        if (exit.error || exit.code !== 0)
          worker.failure = new Error(exit.error ?? `OCR worker exited (${exit.code})`);
      })
      .catch((error: unknown) => {
        if (!worker.retiring)
          worker.failure = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        worker.exited = true;
      });
    worker.ready = (async () => {
      const deadline = Date.now() + (this.ocrOptions.timeoutMs ?? 15_000);
      const ready = confined(directory, "worker.json");
      while (!fs.existsSync(ready)) {
        if (worker.exited)
          throw worker.failure ?? new Error("OCR worker exited before initialization");
        if (Date.now() >= deadline) {
          await this.closeWorker();
          throw new Error("OCR worker initialization timed out");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      z.object({
        protocol: z.literal(1),
        kind: z.literal("ocr-worker"),
        sessionId: z.literal(id),
        pid: z.literal(process.pid),
        engineInitializations: z.literal(1),
      }).parse(JSON.parse(fs.readFileSync(ready, "utf8")));
    })().catch(async (error: unknown) => {
      await this.closeWorker();
      throw error;
    });
    await worker.ready;
    return worker;
  }
  private async closeWorker(): Promise<void> {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    if (!worker) return;
    if (worker.closing) return worker.closing;
    worker.retiring = true;
    const closing = (async () => {
      const released = await worker.scope.stop("quit");
      if (!released.ok) throw new Error(released.errors.join("; "));
      await worker.exit;
      if (this.worker === worker) this.worker = undefined;
      fs.rmSync(worker.directory, { recursive: true, force: true });
    })().finally(() => {
      worker.closing = undefined;
    });
    worker.closing = closing;
    return closing;
  }
  protected override requestCancellation(session: NativeSession): void {
    session.cancelled = true;
    const worker = this.worker;
    if (worker) {
      worker.retiring = true;
      atomicWrite(
        confined(worker.directory, "cancel.request"),
        `${worker.id}:${worker.process.pid}:cancel`,
      );
    }
  }
  override async cancel(): Promise<StopDecision> {
    const cancelled = await super.cancel();
    if (!cancelled.ok) return cancelled;
    try {
      await this.closeWorker();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  override async dispose(): Promise<void> {
    await this.closeWorker();
    await super.dispose();
  }
  protected override async start(session: NativeSession, _args: string[]): Promise<void> {
    const worker = await this.getWorker();
    session.process = worker.process;
    if (session.cancelled) this.requestCancellation(session);
    else
      atomicWrite(
        confined(worker.directory, "request.json"),
        JSON.stringify({
          protocol: 1,
          workerSessionId: worker.id,
          pid: worker.process.pid,
          sessionId: session.id,
        }),
      );
    const result = confined(session.directory, "ocr.json");
    const errorFile = confined(session.directory, "error.json");
    const deadline = Date.now() + 120_000;
    while (!fs.existsSync(result)) {
      if (worker.exited)
        throw worker.failure ?? new Error("OCR worker exited before task completed");
      if (session.cancelled || Date.now() >= deadline || !this.options.scope.accepts(this.owner)) {
        this.requestCancellation(session);
        await worker.exit;
        await this.closeWorker();
        throw new Error("Native task cancelled; late output was discarded");
      }
      if (fs.existsSync(errorFile)) {
        const failure = z
          .object({
            protocol: z.literal(1),
            sessionId: z.literal(session.id),
            pid: z.literal(worker.process.pid),
            error: z.string(),
          })
          .parse(JSON.parse(fs.readFileSync(errorFile, "utf8")));
        throw new Error(failure.error);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (session.cancelled || this.options.scope.state !== "active")
      throw new Error("Native task cancelled; late output was discarded");
    const proof = z
      .object({
        protocol: z.literal(1),
        sessionId: z.literal(session.id),
        pid: z.literal(worker.process.pid),
        workerSessionId: z.literal(worker.id),
        engineInitializations: z.literal(1),
        processed: z.number().int().positive(),
      })
      .parse(JSON.parse(fs.readFileSync(confined(session.directory, "worker-proof.json"), "utf8")));
    atomicWrite(
      confined(this.ocrOptions.dataDir, `sessions/${session.id}.json`),
      JSON.stringify({ ...proof, taskCompleted: true }),
    );
  }
  protected override async finishSession(session: NativeSession): Promise<void> {
    await super.finishSession(session);
    if (
      this.worker &&
      !this.worker.retiring &&
      !this.worker.exited &&
      this.options.scope.state === "active"
    ) {
      this.idleTimer = setTimeout(() => {
        if (!this.current)
          void this.closeWorker().catch((error) =>
            console.error("ocr-worker-idle-shutdown", error),
          );
      }, this.idleTimeoutMs);
      this.idleTimer.unref();
    }
  }
  override async activate(activation: PluginActivation): Promise<JsonValue | undefined> {
    if (activation.commandId === "cancel") return (await this.cancel()) as unknown as JsonValue;
    if (activation.commandId && activation.commandId !== "ocr")
      throw new Error("Unknown OCR command");
    if (activation.context?.kind !== "image") throw new Error("Select an image before running OCR");
    const image = resource.parse(activation.context.resource);
    const filename = await this.ocrOptions.resolveImage(image);
    return this.recognize({
      owner: this.owner,
      sessionId: "resource",
      resource: image,
      path: filename,
      width: 0,
      height: 0,
    });
  }
  async recognize(image: CaptureImage): Promise<JsonValue | undefined> {
    let session: NativeSession | undefined;
    let retained: { image: CaptureImage; resultFile: string } | undefined;
    let registered = false;
    let published = false;
    let savedImage = false;
    let savedResult = false;
    try {
      session = this.createSession();
      const source = checkedPng(image.path);
      const imagePath = confined(session.directory, "selection.png");
      fs.copyFileSync(source.path, imagePath, fs.constants.COPYFILE_EXCL);
      await this.start(session, [`--image-path=${imagePath}`, "--spark233-batch=true"]);
      const recognized = this.readResult(session, "ocr.json", ocrResult);
      if (recognized.width !== source.width || recognized.height !== source.height)
        throw new Error("OCR result dimensions differ from its input image");
      const ownedImage: CaptureImage = {
        owner: this.owner,
        sessionId: session.id,
        path: confined(this.ocrOptions.dataDir, `results/images/${session.id}.png`),
        width: source.width,
        height: source.height,
        resource: {
          id: `${this.owner.pluginId}:${this.owner.instanceId}:${session.id}`,
          kind: "image",
          mimeType: "image/png",
          size: source.size,
        },
      };
      retained = {
        image: ownedImage,
        resultFile: confined(this.ocrOptions.dataDir, `results/${session.id}.json`),
      };
      const result: OcrResult = {
        owner: this.owner,
        sessionId: session.id,
        source: ownedImage.resource,
        width: recognized.width,
        height: recognized.height,
        text: recognized.text,
        detectionMs: recognized.detectionMs,
        recognitionMs: recognized.recognitionMs,
        lines: recognized.lines,
      };
      atomicWrite(ownedImage.path, fs.readFileSync(imagePath));
      savedImage = true;
      atomicWrite(retained.resultFile, JSON.stringify(result));
      savedResult = true;
      // Keep the current result and its immediate predecessor, including while
      // a replacement is being delivered. Failure leaves the current image live.
      while (this.published.length >= 2) {
        const previous = this.published[0];
        await this.ocrOptions.onImageReleased?.(previous.image);
        fs.rmSync(previous.image.path, { force: true });
        fs.rmSync(previous.resultFile, { force: true });
        this.published.shift();
      }
      if (session.cancelled || this.ocrOptions.scope.state !== "active")
        throw new Error("Native task cancelled; late output was discarded");
      registered = true;
      await this.ocrOptions.onImage?.(ownedImage);
      if (session.cancelled || this.ocrOptions.scope.state !== "active")
        throw new Error("Native task cancelled; late output was discarded");
      await this.ocrOptions.onResult?.(result);
      this.published.push(retained);
      published = true;
      return result as unknown as JsonValue;
    } finally {
      try {
        if (retained && !published) {
          if (registered) await this.ocrOptions.onImageReleased?.(retained.image);
          if (savedImage) fs.rmSync(retained.image.path, { force: true });
          if (savedResult) fs.rmSync(retained.resultFile, { force: true });
        }
        const importRoot = confined(this.ocrOptions.dataDir, "images");
        if (
          inside(importRoot, canonical(image.path)) &&
          /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.png$/i.test(path.basename(image.path))
        ) {
          await this.ocrOptions.onImageReleased?.(image);
          fs.rmSync(image.path, { force: true });
        }
      } finally {
        if (session) await this.finishSession(session);
      }
    }
  }
}

export async function createCaptureRuntime(
  options: CaptureRuntimeOptions,
): Promise<CaptureRuntime> {
  if (!(await options.approveTrust()))
    throw new Error("Native screenshot execution requires host trust approval");
  return new CaptureController(options, "capture");
}
export async function createOcrRuntime(options: OcrRuntimeOptions): Promise<OcrRuntime> {
  if (!(await options.approveTrust()))
    throw new Error("Native OCR execution requires host trust approval");
  return new OcrController(options);
}
