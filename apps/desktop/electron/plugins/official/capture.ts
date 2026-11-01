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
import { CaptureHistory, type CaptureAction } from "./capture-history.js";

export interface CaptureImage {
  owner: PluginOwner;
  sessionId: string;
  resource: ResourceHandle;
  /** Trusted host-only path; never accepted from activation parameters. */
  path: string;
  width: number;
  height: number;
}
export interface CapturePinBounds {
  /** Windows physical pixels, including negative virtual-desktop origins. */
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CapturePinImage extends CaptureImage {
  attempt: number;
  sourcePath: string;
  documentPath: string;
  bounds: CapturePinBounds;
  scale: number;
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
  /** Every completed screenshot, whether or not it was forwarded to OCR. */
  onResult?: (image: CaptureImage, action: CaptureAction) => void | Promise<void>;
  canPinToDesktop?: () => boolean;
  /** Copies the session bundle into durable host storage before acknowledging native exit. */
  onPin?: (image: CapturePinImage, isCurrent: () => boolean) => Promise<string>;
  onPinAborted?: (pinId: string) => Promise<void>;
  onPinAcknowledged?: (pinId: string) => Promise<void>;
  /** Milliseconds of annotation work are the user's; this bounds process shutdown. */
  timeoutMs?: number;
  /** Overridable for tests; defaults to a bounded history in the plugin data dir. */
  history?: CaptureHistory;
  /** Entries kept in history; the oldest image is dropped first. */
  historyLimit?: number;
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
  lines: Array<{
    text: string;
    score: number;
    box: number[][];
    characters?: Array<{ text: string; box: number[][] }>;
  }>;
}
export interface CaptureRuntime {
  readonly owner: PluginOwner;
  readonly activeSession: string | undefined;
  activate(activation: PluginActivation): Promise<JsonValue | undefined>;
  /** Trusted host entry only; activation payloads cannot supply paths. */
  editPin(input: {
    sourcePath: string;
    documentPath: string;
    bounds?: CapturePinBounds;
  }): Promise<JsonValue | undefined>;
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
  // Copy, save and OCR all publish the same selection; only OCR opens a text pane.
  action: z.enum(["copy", "save", "ocr"]),
  image: z.literal("selection.png"),
});
const pinBounds = z.object({
  x: z.number().int().min(-1_000_000).max(1_000_000),
  y: z.number().int().min(-1_000_000).max(1_000_000),
  width: z.number().int().positive().max(65536),
  height: z.number().int().positive().max(65536),
});
const pinIdentity = envelope.pick({ protocol: true, sessionId: true, pid: true }).extend({
  attempt: z.number().int().positive().max(1_000_000),
});
const pinResult = envelope
  .extend({
    kind: z.literal("pin"),
    action: z.literal("pin"),
    attempt: pinIdentity.shape.attempt,
    image: z.literal("pin.png"),
    source: z.literal("pin-source.png"),
    document: z.literal("pin-document.json"),
    width: z.number().int().positive().max(16000),
    height: z.number().int().positive().max(16000),
    bounds: pinBounds,
    scale: z.number().finite().min(0.1).max(8),
  })
  .refine((value) => value.width * value.height <= 32_000_000);
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
        characters: z
          .array(
            z.object({
              text: z.string(),
              box: z.array(z.array(z.number().finite()).length(2)).length(4),
            }),
          )
          .max(20000)
          .optional(),
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
  exited?: boolean;
  pinId?: string;
  pinPublication?: string;
  cleanupFailed?: boolean;
  pinFile?: string;
  pinAttempts?: Set<number>;
  pinAck?: { attempt: number; status: "accepted" | "rejected"; pinId?: string };
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
  private historyStore?: CaptureHistory | null;
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
  /** Only the screenshot plugin keeps history; OCR input is a borrowed image. */
  protected get history(): CaptureHistory | undefined {
    if (this.historyStore === undefined) {
      const options = this.options as CaptureRuntimeOptions;
      this.historyStore =
        this.kind === "capture"
          ? (options.history ??
            new CaptureHistory(options.dataDir, { maxEntries: options.historyLimit ?? 50 }))
          : null;
    }
    return this.historyStore ?? undefined;
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
    if (session.cleanupFailed && session.exited)
      try {
        await this.finishSession(session);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Native publication rollback is still pending: ${String(error)}`,
        };
      }
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
    session.exited = true;
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
    try {
      await this.abortPin(session);
    } catch (error) {
      session.cleanupFailed = true;
      throw error;
    }
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
  private pinAllowed(): boolean {
    const options = this.options as CaptureRuntimeOptions;
    try {
      return !!options.onPin && options.canPinToDesktop?.() === true;
    } catch {
      return false;
    }
  }
  private sessionCurrent(session: NativeSession): boolean {
    return (
      this.current === session &&
      !this.disposed &&
      !session.cancelled &&
      !session.exited &&
      this.options.scope.state === "active" &&
      this.options.scope.accepts(this.owner)
    );
  }
  private async abortPin(session: NativeSession): Promise<void> {
    if (!session.pinPublication || session.pinId) return;
    await (this.options as CaptureRuntimeOptions).onPinAborted?.(session.pinPublication);
    session.pinPublication = undefined;
    session.pinAck = undefined;
  }
  private async writePinAck(session: NativeSession): Promise<void> {
    const ack = session.pinAck;
    if (!ack || !this.sessionCurrent(session)) return;
    if (ack.status === "accepted" && !this.pinAllowed()) {
      await this.abortPin(session);
      session.pinAck = { attempt: ack.attempt, status: "rejected" };
      return this.writePinAck(session);
    }
    atomicWrite(
      confined(session.directory, "pin.ack"),
      `${session.id}:${session.process!.pid}:${ack.attempt}:${ack.status}`,
    );
    if (ack.status === "accepted") session.pinId = ack.pinId;
    session.pinAck = undefined;
    if (ack.status === "accepted")
      try {
        await (this.options as CaptureRuntimeOptions).onPinAcknowledged?.(ack.pinId!);
      } catch (error) {
        // Native has already accepted transfer. A failed old-revision GC must
        // preserve the new durable pin and must not retract its acknowledgement.
        console.error("capture-pin-gc", error);
      }
  }
  private async pollPin(session: NativeSession): Promise<void> {
    if (!session.process || !this.sessionCurrent(session) || session.pinId) return;
    if (session.pinAck) {
      await this.writePinAck(session);
      return;
    }
    const file = confined(session.directory, "pin.json");
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file, { bigint: true });
    const signature = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    if (session.pinFile === signature) return;
    session.pinFile = signature;
    if (!stat.isFile() || stat.size > 64n * 1024n)
      throw new Error("Native pin envelope exceeds its file budget");
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const identity = pinIdentity.parse(raw);
    if (identity.sessionId !== session.id || identity.pid !== session.process.pid)
      throw new Error("Native pin session/PID identity mismatch");
    const attempts = (session.pinAttempts ??= new Set<number>());
    if (attempts.has(identity.attempt)) return;
    attempts.add(identity.attempt);
    let currentAttempt = true;
    const isCurrent = () => currentAttempt && this.sessionCurrent(session) && this.pinAllowed();
    try {
      const selected = pinResult.parse(raw);
      if (!isCurrent()) throw new Error("Desktop pinning is unavailable for this session");
      const png = checkedPng(confined(session.directory, selected.image));
      const source = checkedPng(confined(session.directory, selected.source));
      const documentPath = checkedPinDocument(confined(session.directory, selected.document));
      if (
        ![png.path, source.path, documentPath].every((value) =>
          inside(canonical(session.directory), value),
        ) ||
        png.width !== selected.width ||
        png.height !== selected.height ||
        source.width !== selected.width ||
        source.height !== selected.height
      )
        throw new Error("Native pin files escape the session or have inconsistent dimensions");
      const image: CapturePinImage = {
        owner: this.owner,
        sessionId: session.id,
        attempt: selected.attempt,
        path: png.path,
        sourcePath: source.path,
        documentPath,
        width: png.width,
        height: png.height,
        bounds: selected.bounds,
        scale: selected.scale,
        resource: {
          id: `${this.owner.pluginId}:${this.owner.instanceId}:${session.id}:pin:${selected.attempt}`,
          kind: "image",
          mimeType: "image/png",
          size: png.size,
        },
      };
      const pinId = await (this.options as CaptureRuntimeOptions).onPin!(image, isCurrent);
      if (typeof pinId !== "string" || !pinId || pinId.length > 512)
        throw new Error("Desktop pin publisher returned an invalid identity");
      session.pinPublication = pinId;
      if (!isCurrent()) {
        await this.abortPin(session);
        return;
      }
      session.pinAck = { attempt: selected.attempt, status: "accepted", pinId };
    } catch (error) {
      currentAttempt = false;
      await this.abortPin(session);
      session.pinAck = { attempt: identity.attempt, status: "rejected" };
      console.error("capture-pin", error);
    }
    await this.writePinAck(session);
  }
  async editPin(input: {
    sourcePath: string;
    documentPath: string;
    bounds?: CapturePinBounds;
  }): Promise<JsonValue | undefined> {
    if (this.kind !== "capture") throw new Error("Only screenshots accept pinned-image editing");
    return this.capture({ commandId: "capture" }, (session) => {
      if (!path.isAbsolute(input.sourcePath) || !path.isAbsolute(input.documentPath))
        throw new Error("Pinned-image editing requires trusted absolute host paths");
      const source = checkedPng(input.sourcePath);
      const documentPath = checkedPinDocument(input.documentPath);
      atomicWrite(confined(session.directory, "edit-source.png"), fs.readFileSync(source.path));
      atomicWrite(confined(session.directory, "edit-document.json"), fs.readFileSync(documentPath));
      if (input.bounds)
        atomicWrite(
          confined(session.directory, "edit-bounds.json"),
          JSON.stringify(pinBounds.parse(input.bounds)),
        );
    });
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
    return this.capture(activation);
  }
  private async capture(
    activation: PluginActivation,
    prepareEdit?: (session: NativeSession) => void,
  ): Promise<JsonValue | undefined> {
    const options = this.options as CaptureRuntimeOptions;
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
    let pinTimer: ReturnType<typeof setInterval> | undefined;
    let pinTask = Promise.resolve();
    let pinBusy = false;
    try {
      prepareEdit?.(session);
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
      const hostPin = this.pinAllowed();
      if (hostPin)
        pinTimer = setInterval(() => {
          if (pinBusy || !this.sessionCurrent(session)) return;
          pinBusy = true;
          pinTask = this.pollPin(session)
            .catch((error) => console.error("capture-pin", error))
            .finally(() => {
              pinBusy = false;
            });
        }, 100);
      await this.start(session, [
        "--auto-quit=true",
        `--spark233-locale=${options.getLocale?.().toLowerCase().startsWith("en") ? "en-US" : "zh-CN"}`,
        ...(activation.commandId === "ocr" ? ["--enter=ocr"] : []),
        ...(hostPin ? ["--spark233-pin-host=true", `--spark233-pin-owner-pid=${process.pid}`] : []),
        ...(prepareEdit ? ["--spark233-edit-pin=true"] : []),
      ]);
      clearInterval(pinTimer);
      await pinTask;
      if (session.pinId) return { status: "pinned", pinId: session.pinId };
      // A cancelled selection publishes nothing; every completed one publishes exactly
      // once, whatever the user did with it.
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
      // History is a record of the screenshot, not a precondition for it: a failed
      // copy must never turn a saved screenshot into an error.
      try {
        this.history?.add(imagePath, {
          width: png.width,
          height: png.height,
          action: selected.action,
        });
      } catch (error) {
        console.error("capture-history", error);
      }
      await options.onResult?.(image, selected.action);
      if (selected.action !== "ocr")
        return {
          status: selected.action,
          image: image.resource as unknown as JsonValue,
          width: png.width,
          height: png.height,
        };
      if (!options.getOcrStatus().available || !options.recognize)
        return {
          status: "ocr-unavailable",
          image: image.resource as unknown as JsonValue,
          reason: options.getOcrStatus().reason ?? "OCR plugin is disabled",
        };
      return await options.recognize(image);
    } finally {
      clearInterval(availabilityTimer);
      clearInterval(pinTimer);
      await pinTask;
      await this.finishSession(session);
    }
  }
}

export function checkedPng(filename: string): {
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
function checkedPinDocument(filename: string): string {
  const real = fs.realpathSync(filename),
    stat = fs.statSync(real);
  if (!stat.isFile() || !stat.size || stat.size > 8 * 1024 * 1024)
    throw new Error("Pinned-image document exceeds 8 MiB or is not a file");
  const value: unknown = JSON.parse(fs.readFileSync(real, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pinned-image document must be a JSON object");
  return real;
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
      forceTerminate: async () => {
        if (!this.worker) return;
        const result = await this.worker.scope.forceTerminateProcesses();
        if (!result.ok) throw new Error(result.errors.join("; "));
      },
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
