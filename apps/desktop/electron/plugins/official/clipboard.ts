import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type {
  JsonValue,
  PluginActivation,
  PluginOwner,
  StopReason,
  ResourceHandle,
} from "@spark233/sdk";
import type { ClipboardRequest } from "../../../src/features/clipboard/types.js";
import type { PluginBackendController } from "../backend.js";
import { atomicWrite, canonical, confined, inside } from "../../persistence.js";
import { PluginResourceScope, type StopDecision } from "../resources.js";

export interface ClipboardRuntimeOptions {
  scope: PluginResourceScope;
  backend: Pick<PluginBackendController, "activate" | "maintenance" | "prepareStop" | "running">;
  pluginRoot: string;
  descriptor: { path: string; args: string[] };
  dataDir: string;
  cacheDir: string;
  approveTrust: () => boolean | Promise<boolean>;
  onChange?: () => void;
  onError?: (error: Error) => void;
  openWorkspace?: (presentation?: {
    compact: boolean;
    position: "cursor" | "edge";
  }) => void | Promise<void>;
  beforePaste?: () => void | Promise<void>;
  prepareWorkspace?: () => Promise<StopDecision>;
  /** Only the host's native picker supplies normalized PNGs, never page paths. */
  pickImages?: () => Promise<Array<{ name: string; png: Uint8Array }>>;
  renderThumbnail?: (image: Uint8Array) => Uint8Array;
  /** Isolated mode requires the private station created by the native boundary. */
  mode?: "production" | "isolated";
  timeoutMs?: number;
}
export interface ClipboardRuntime {
  readonly owner: PluginOwner;
  readonly pid: number | undefined;
  activate(activation: PluginActivation): Promise<JsonValue | undefined>;
  request(command: ClipboardRequest): Promise<unknown>;
  rememberTarget(): Promise<void>;
  imageResource(id: string): Promise<{ resource: ResourceHandle; path: string }>;
  prepareStop(reason: StopReason): Promise<StopDecision>;
  dispose(): Promise<void>;
}
const requestActions = z.enum([
  "list",
  "detail",
  "draft.save",
  "draft.remove",
  "gallery.import",
  "copy",
  "paste",
  "update",
  "favorite",
  "history.remove",
  "settings",
  "groups",
  "merge",
  "cleanup.preview",
  "cleanup.confirm",
  "emoji.list",
  "emoji.add",
  "emoji.remove",
  "emoji.copy",
]);
const nativeEnvelope = z.object({
  protocol: z.literal(1),
  sessionId: z.string(),
  type: z.string(),
});
const snapshotEvent = nativeEnvelope.extend({
  type: z.literal("snapshot"),
  file: z.string().regex(/^snapshot-[0-9]+-[0-9]+\.scb$/),
  sequence: z.number().int().nonnegative(),
  source: z.object({
    executable: z.string().max(32768),
    title: z.string().max(512),
    pid: z.number().int().nonnegative(),
  }),
});
const recoveryOwner = z.strictObject({
  protocol: z.literal(1),
  pluginId: z.string(),
  sessionId: z.string().uuid(),
});
const recoveryDraft = z.strictObject({
  action: z.literal("draft.save"),
  id: z.string().min(1).max(100),
  text: z.string().max(8 * 1024 * 1024),
  note: z.string().max(10000),
  tags: z.string().max(10000),
});
const pendingSnapshot = /^snapshot-[0-9]+-([0-9]+)\.scb$/;

/** Move acknowledged recovery material into the backed-up plugin data domain.
 * Each file is durable at its destination before the cache copy is removed. */
export function retainClipboardSpool(options: {
  cacheDir: string;
  dataDir: string;
  pluginId: string;
  sessionId: string;
}): void {
  const source = confined(options.cacheDir, "native", options.sessionId);
  if (!fs.existsSync(source)) return;
  const ownerFile = confined(source, "owner.json");
  if (fs.statSync(ownerFile).size > 4096) throw new Error("Invalid clipboard recovery owner");
  const owner = recoveryOwner.parse(JSON.parse(fs.readFileSync(ownerFile, "utf8")));
  if (owner.pluginId !== options.pluginId || owner.sessionId !== options.sessionId)
    throw new Error("Clipboard recovery session identity mismatch");
  const files = fs
    .readdirSync(source)
    .filter(
      (file) =>
        pendingSnapshot.test(file) ||
        /^snapshot-[0-9]+-[0-9]+\.scb\.json$/.test(file) ||
        /^draft-[\da-f]+\.json$/.test(file),
    );
  if (!files.length) return;
  const destination = confined(options.dataDir, "recovery", options.sessionId);
  // Publish ownership before files so an interrupted migration can be resumed.
  atomicWrite(confined(destination, "owner.json"), JSON.stringify(owner));
  // Metadata reaches the data domain before its raw file, including if a
  // migration is interrupted between files and resumed at the next startup.
  files.sort((a, b) => Number(pendingSnapshot.test(a)) - Number(pendingSnapshot.test(b)));
  for (const file of files) {
    const input = confined(source, file),
      output = confined(destination, file);
    const maximum = pendingSnapshot.test(file)
      ? 64 * 1024 * 1024 + 8192
      : file.startsWith("draft-")
        ? 34 * 1024 * 1024
        : 256 * 1024;
    if (!fs.statSync(input).isFile() || fs.statSync(input).size > maximum)
      throw new Error("Clipboard recovery file exceeds its budget");
    atomicWrite(output, fs.readFileSync(input));
    fs.rmSync(input);
  }
}

/** Replay only host-owned previous sessions through the new private backend.
 * No clipboard API is used: these are already captured files and editor drafts. */
export async function recoverClipboardSpools(options: {
  cacheDir: string;
  dataDir: string;
  pluginId: string;
  sessionId: string;
  backend: Pick<PluginBackendController, "activate">;
}): Promise<void> {
  // Upgrade previous cache-only recovery before reading the business-data copy.
  const legacyRoot = confined(options.cacheDir, "native");
  if (fs.existsSync(legacyRoot))
    for (const name of fs.readdirSync(legacyRoot))
      if (name !== options.sessionId && z.string().uuid().safeParse(name).success)
        retainClipboardSpool({ ...options, sessionId: name });
  const root = confined(options.dataDir, "recovery");
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (name === options.sessionId || !z.string().uuid().safeParse(name).success) continue;
    const directory = confined(root, name),
      ownerFile = confined(directory, "owner.json");
    if (!fs.existsSync(ownerFile)) continue;
    if (fs.statSync(ownerFile).size > 4096) throw new Error("Invalid clipboard recovery owner");
    const owner = recoveryOwner.parse(JSON.parse(fs.readFileSync(ownerFile, "utf8")));
    if (owner.pluginId !== options.pluginId || owner.sessionId !== name)
      throw new Error("Clipboard recovery session identity mismatch");
    const call = (parameters: object) =>
      options.backend.activate({
        commandId: "data",
        parameters: JSON.parse(JSON.stringify(parameters)) as JsonValue,
      });
    const names = fs.readdirSync(directory);
    for (const file of names
      .filter((file) => pendingSnapshot.test(file))
      .sort((a, b) => Number(pendingSnapshot.exec(a)![1]) - Number(pendingSnapshot.exec(b)![1]))) {
      const filename = confined(directory, file),
        metadata = confined(directory, `${file}.json`);
      if (fs.statSync(filename).size > 64 * 1024 * 1024 + 8192)
        throw new Error("Clipboard recovery snapshot exceeds its budget");
      let source: z.infer<typeof snapshotEvent>["source"] = {
        executable: "",
        title: "Recovered clipboard snapshot",
        pid: 0,
      };
      if (fs.existsSync(metadata)) {
        if (fs.statSync(metadata).size > 256 * 1024)
          throw new Error("Clipboard recovery metadata exceeds its budget");
        const event = snapshotEvent.parse(JSON.parse(fs.readFileSync(metadata, "utf8")));
        if (event.sessionId !== name || event.file !== file)
          throw new Error("Clipboard recovery snapshot identity mismatch");
        source = event.source;
      }
      const staged = confined(options.cacheDir, `recovery-${randomUUID()}.scb`);
      try {
        atomicWrite(staged, fs.readFileSync(filename));
        z.object({ captured: z.boolean() }).parse(
          await call({ action: "native.capture", file: staged, source }),
        );
        // captured:false is a successful privacy-policy rejection, not a write
        // failure. Do not retain or retry intentionally excluded content.
      } finally {
        fs.rmSync(staged, { force: true });
      }
      fs.rmSync(filename);
      fs.rmSync(metadata, { force: true });
    }
    for (const file of names.filter((file) => /^draft-[\da-f]+\.json$/.test(file))) {
      const filename = confined(directory, file);
      if (fs.statSync(filename).size > 34 * 1024 * 1024)
        throw new Error("Clipboard recovery draft exceeds its budget");
      const draft = recoveryDraft.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
      await call(draft);
      fs.rmSync(filename);
    }
    await call({ action: "checkpoint" });
    fs.rmSync(directory, { recursive: true });
  }
}

class ClipboardController implements ClipboardRuntime {
  readonly owner: PluginOwner;
  private readonly sessionId = randomUUID();
  private readonly spool: string;
  private readonly recovery: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private queue: Array<z.infer<typeof snapshotEvent>> = [];
  private operations: Promise<unknown> = Promise.resolve();
  private targetVersion = 0;
  private targetValid = false;
  private ended = false;
  private stopping = false;
  private closed = false;
  private frozenForStop = false;
  private preserveSpool = false;
  private resuming = false;
  private lastError?: string;
  private stdout = "";
  private decoder = new StringDecoder("utf8");
  private ready!: () => void;
  private failReady!: (error: Error) => void;
  private readyPromise: Promise<void>;
  private exit: Promise<number | null>;
  private resumeTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: ClipboardRuntimeOptions) {
    this.owner = options.scope.owner;
    if (options.scope.state !== "active") throw new Error("Clipboard scope is not active");
    if (
      ![options.pluginRoot, options.descriptor.path, options.dataDir, options.cacheDir].every(
        (filename) => path.isAbsolute(filename),
      )
    )
      throw new Error("Clipboard package/data paths must be absolute and host resolved");
    const root = canonical(options.pluginRoot),
      // Same resolver as root: fs.realpathSync keeps 8.3 aliases (RUNNER~1) and
      // would report a temp-dir helper as an escape on CI runners.
      executable = canonical(options.descriptor.path);
    if (
      !inside(root, executable) ||
      !fs.statSync(executable).isFile() ||
      !/\.exe$/i.test(executable)
    )
      throw new Error("Clipboard executable escaped its validated package");
    if (options.descriptor.args.length)
      throw new Error("Official clipboard session arguments are host controlled");
    if (options.mode === "isolated" && !process.env.SPARK233_CLIPBOARD_STATION)
      throw new Error("Isolated clipboard mode requires a private window station launcher");
    for (const directory of [options.dataDir, options.cacheDir]) {
      if (inside(root, canonical(directory)))
        throw new Error("Clipboard data must be outside its immutable plugin package");
      fs.mkdirSync(directory, { recursive: true });
    }
    this.spool = confined(options.cacheDir, `native/${this.sessionId}`);
    this.recovery = confined(options.dataDir, "recovery", this.sessionId);
    fs.mkdirSync(this.spool, { recursive: true });
    atomicWrite(
      confined(this.spool, "owner.json"),
      JSON.stringify({ protocol: 1, pluginId: this.owner.pluginId, sessionId: this.sessionId }),
    );
    this.readyPromise = new Promise((resolve, reject) => {
      this.ready = resolve;
      this.failReady = reject;
    });
    this.child = spawn(
      executable,
      [
        `--spark233-session=${this.sessionId}`,
        `--spark233-spool=${this.spool}`,
        `--spark233-mode=${options.mode ?? "production"}`,
        `--spark233-host-pid=${process.pid}`,
      ],
      { cwd: root, shell: false, windowsHide: true, stdio: "pipe" },
    );
    this.exit = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.failReady(error);
        this.report(error);
      });
      this.child.once("close", (code) => {
        this.ended = true;
        const error = new Error(`Clipboard native process exited (${code})`);
        this.failReady(error);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (!this.stopping) this.report(error);
        resolve(code);
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.lastError = String(chunk).slice(0, 2000);
    });
    this.resumeTimer = setInterval(() => {
      if (
        options.scope.state === "active" &&
        this.frozenForStop &&
        options.backend.running &&
        !this.stopping &&
        !this.resuming
      ) {
        this.resuming = true;
        void this.configure()
          .then(() => {
            this.frozenForStop = false;
          })
          .catch((error) => this.report(error instanceof Error ? error : new Error(String(error))))
          .finally(() => {
            this.resuming = false;
          });
      }
      if (options.scope.state === "active" && options.backend.running && this.queue.length)
        this.flush();
    }, 100);
    options.scope.own("event", { dispose: () => clearInterval(this.resumeTimer) });
    options.scope.own("process", {
      prepareStop: (reason) => this.prepareStop(reason),
      dispose: () => this.dispose(),
      forceTerminate: async () => {
        this.stopping = true;
        if (!this.ended) this.child.kill();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.exit,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Clipboard process remains tracked after forced exit")),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }
  get pid() {
    return this.child.pid;
  }
  private notify() {
    try {
      this.options.onChange?.();
    } catch (error) {
      console.error("clipboard-change-notification", error);
    }
  }
  private report(error: Error) {
    this.lastError = error.message;
    try {
      this.options.onError?.(error);
    } catch (callbackError) {
      console.error("clipboard-error-notification", callbackError);
    }
    this.notify();
  }
  private receive(chunk: Buffer) {
    this.stdout += this.decoder.write(chunk);
    if (this.stdout.length > 1024 * 1024) {
      this.report(new Error("Native clipboard response exceeded 1 MiB"));
      this.stdout = "";
      return;
    }
    let newline: number;
    while ((newline = this.stdout.indexOf("\n")) !== -1) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      try {
        const value = JSON.parse(line),
          envelope = nativeEnvelope.parse(value);
        if (envelope.sessionId !== this.sessionId) continue;
        if (envelope.type === "ready") {
          const ready = z
            .object({ pid: z.literal(this.child.pid), station: z.string() })
            .parse(value);
          if (this.options.mode === "isolated" && ready.station.toLocaleLowerCase() === "winsta0")
            throw new Error("Native helper is on the real user clipboard station");
          this.ready();
        } else if (envelope.type === "response") {
          const response = z
            .object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })
            .parse(value);
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          if (response.ok) pending.resolve();
          else pending.reject(new Error(response.error ?? "Clipboard native operation failed"));
        } else if (
          envelope.type === "snapshot" &&
          !this.stopping &&
          ["active", "preparing"].includes(this.options.scope.state)
        ) {
          const event = snapshotEvent.parse(value);
          atomicWrite(confined(this.spool, `${event.file}.json`), JSON.stringify(event));
          this.queue.push(event);
          if (this.options.backend.running) this.flush();
        } else if (envelope.type === "error")
          this.report(new Error(z.object({ error: z.string() }).parse(value).error));
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  private serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.operations.catch(() => {}).then(operation);
    this.operations = next;
    return next;
  }
  private async data<T = unknown>(parameters: object): Promise<T> {
    const draft = recoveryDraft.safeParse(parameters);
    const draftFile = draft.success
      ? confined(this.recovery, `draft-${Buffer.from(draft.data.id).toString("hex")}.json`)
      : undefined;
    if (draftFile) {
      atomicWrite(
        confined(this.recovery, "owner.json"),
        JSON.stringify({ protocol: 1, pluginId: this.owner.pluginId, sessionId: this.sessionId }),
      );
      atomicWrite(draftFile, JSON.stringify(draft.data));
      // The workspace can durably finish its draft handoff after a backend exit.
      // A living backend still supplies the real save acknowledgement below.
      if (!this.options.backend.running) {
        this.preserveSpool = true;
        return { saved: true, recovery: true } as T;
      }
    }
    const activation = {
      commandId: "data",
      parameters: JSON.parse(JSON.stringify(parameters)) as JsonValue,
    };
    let result: unknown;
    if (this.options.scope.state === "active")
      result = await this.options.backend.activate(activation);
    else if (this.options.scope.state === "preparing")
      result = await this.options.backend.maintenance(activation);
    else throw new Error("Clipboard data backend is not accepting work");
    if (draftFile) fs.rmSync(draftFile, { force: true });
    const input = parameters as Record<string, unknown>;
    if (
      typeof input.id === "string" &&
      (input.action === "draft.remove" ||
        (input.action === "update" &&
          ["editedText", "note", "tags"].some((field) => input[field] !== undefined)))
    )
      fs.rmSync(confined(this.recovery, `draft-${Buffer.from(input.id).toString("hex")}.json`), {
        force: true,
      });
    return result as T;
  }
  private flush() {
    void this.serial(() => this.drain()).catch((error) =>
      this.report(error instanceof Error ? error : new Error(String(error))),
    );
  }
  private async drain(preparing = false) {
    while (
      this.queue.length &&
      !this.stopping &&
      (preparing || this.options.scope.state === "active")
    ) {
      const event = this.queue[0],
        filename = confined(this.spool, event.file);
      if (fs.statSync(filename).size > 64 * 1024 * 1024 + 8192)
        throw new Error("Clipboard snapshot exceeded 64 MiB");
      // A failed data write retains the spool item and refuses a false save ack.
      const result = await this.data<{ captured: boolean }>({
        action: "native.capture",
        file: filename,
        source: event.source,
      });
      this.queue.shift();
      fs.rmSync(filename, { force: true });
      fs.rmSync(confined(this.spool, `${event.file}.json`), { force: true });
      if (result.captured) this.notify();
    }
  }
  private rpc(
    operation: string,
    payload: Record<string, unknown> = {},
    timeoutMs = this.options.timeoutMs ?? 10000,
  ) {
    if (this.ended)
      return Promise.reject(new Error(this.lastError ?? "Clipboard native helper is not running"));
    const id = randomUUID();
    const message = `${JSON.stringify({ protocol: 1, sessionId: this.sessionId, id, operation, ...payload })}\n`;
    if (Buffer.byteLength(message) > 65536)
      return Promise.reject(new Error("原生剪贴板请求超过 64 KiB"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native clipboard ${operation} timed out; process remains tracked`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(message, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async initialize() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Clipboard helper startup timed out")),
            this.options.timeoutMs ?? 10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await recoverClipboardSpools({
      cacheDir: this.options.cacheDir,
      dataDir: this.options.dataDir,
      pluginId: this.owner.pluginId,
      sessionId: this.sessionId,
      backend: this.options.backend,
    });
    await this.configure();
  }
  private async policy() {
    return z
      .object({
        paused: z.boolean(),
        excludedApps: z.array(z.string()).max(256),
        compactPosition: z.enum(["cursor", "edge"]),
      })
      .passthrough()
      .parse(await this.data({ action: "settings" }));
  }
  private async configure() {
    const policy = await this.policy();
    return this.rpc("configure", { paused: policy.paused, excludedApps: policy.excludedApps });
  }
  rememberTarget(): Promise<void> {
    if (this.closed || this.stopping || this.options.scope.state !== "active")
      return Promise.reject(new Error("Clipboard runtime is stopping"));
    const version = ++this.targetVersion;
    this.targetValid = false;
    // This control RPC must not wait for history persistence or image conversion.
    // A late acknowledgement cannot authorize pasting after a newer capture.
    return this.rpc("remember", {}, Math.min(this.options.timeoutMs ?? 150, 150))
      .then(() => {
        if (version === this.targetVersion) this.targetValid = true;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "no external paste target is available")
          return;
        throw error;
      });
  }
  private assertPasteTarget(version: number): void {
    if (!this.targetValid || version !== this.targetVersion)
      throw new Error("粘贴目标已失效，请从目标应用重新打开剪贴板，或复制后手动粘贴");
  }
  private async exportedImage(id: string) {
    const info = z
      .object({
        path: z.string(),
        mimeType: z.enum(["image/png", "image/bmp"]),
        size: z
          .number()
          .int()
          .nonnegative()
          .max(64 * 1024 * 1024),
        thumbnailReady: z.boolean().optional(),
      })
      .parse(await this.data({ action: "image.export", id }));
    const filename = canonical(info.path),
      root = confined(this.options.dataDir, "exports");
    if (
      !inside(root, filename) ||
      !fs.statSync(filename).isFile() ||
      fs.statSync(filename).size !== info.size
    )
      throw new Error("Image export escaped its owned resource domain");
    return { ...info, path: filename };
  }
  imageResource(id: string): Promise<{ resource: ResourceHandle; path: string }> {
    if (this.closed || this.stopping || this.options.scope.state !== "active")
      return Promise.reject(new Error("Clipboard runtime is stopping"));
    return this.serial(async () => {
      await this.ensurePng(id);
      const image = await this.exportedImage(id);
      return {
        path: image.path,
        resource: {
          id: `${this.owner.pluginId}:${this.owner.instanceId}:${id}`,
          kind: "image",
          mimeType: image.mimeType,
          size: image.size,
        },
      };
    });
  }
  private async ensurePng(id: string) {
    const image = await this.exportedImage(id);
    if (image.mimeType === "image/png") return;
    const stem = `convert-${randomUUID()}`,
      input = confined(this.spool, `${stem}.bmp`),
      output = confined(this.spool, `${stem}.png`);
    fs.copyFileSync(image.path, input, fs.constants.COPYFILE_EXCL);
    try {
      await this.rpc("convert-image", {
        input: path.basename(input),
        output: path.basename(output),
      });
      if (fs.statSync(output).size > 64 * 1024 * 1024) throw new Error("转换后的图片超过 64 MiB");
      await this.data({ action: "image.cache", id, file: output });
    } finally {
      fs.rmSync(input, { force: true });
      fs.rmSync(output, { force: true });
    }
  }
  private async ensureThumbnail(id: string) {
    if (!this.options.renderThumbnail) return;
    const image = await this.exportedImage(id);
    if (image.thumbnailReady) return;
    const bytes = fs.readFileSync(image.path);
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 100_000_000
    )
      throw new Error("Image dimensions exceed the preview budget");
    const output = confined(this.spool, `thumbnail-${randomUUID()}.png`);
    atomicWrite(output, this.options.renderThumbnail(bytes));
    try {
      await this.data({ action: "thumbnail.cache", id, file: output });
    } finally {
      fs.rmSync(output, { force: true });
    }
  }
  private async restore(
    id: string,
    mode: "original" | "text" | "image-file" = "original",
    paste = false,
    emoji = false,
    targetVersion = this.targetVersion,
  ) {
    if (paste) this.assertPasteTarget(targetVersion);
    const name = `restore-${randomUUID()}.scb`,
      filename = confined(this.spool, name);
    try {
      const result = z
        .object({
          file: z.string(),
          bytes: z
            .number()
            .int()
            .nonnegative()
            .max(64 * 1024 * 1024 + 8192),
        })
        .parse(
          await this.data({
            action: emoji ? "emoji.snapshot" : "snapshot",
            id,
            mode,
            file: filename,
          }),
        );
      if (
        canonical(result.file) !== canonical(filename) ||
        !fs.statSync(filename).isFile() ||
        fs.statSync(filename).size !== result.bytes
      )
        throw new Error("Clipboard replay output identity mismatch");
      if (paste) {
        this.assertPasteTarget(targetVersion);
        await this.options.beforePaste?.();
        this.assertPasteTarget(targetVersion);
      }
      await this.rpc(paste ? "paste" : "restore", { file: name });
      await this.data({ action: emoji ? "emoji.used" : "copied", id });
      return { copied: true, pasted: paste };
    } finally {
      fs.rmSync(filename, { force: true });
    }
  }
  request(command: ClipboardRequest): Promise<unknown> {
    requestActions.parse(command.action);
    const accepts = () =>
      this.options.scope.state === "active" ||
      (command.action === "draft.save" && this.options.scope.state === "preparing");
    if (this.closed || this.stopping || !accepts())
      return Promise.reject(new Error("剪贴板插件正在停止"));
    const targetVersion = this.targetVersion;
    return this.serial(async () => {
      if (this.closed || this.stopping || !accepts()) throw new Error("剪贴板插件正在停止");
      let result: unknown;
      switch (command.action) {
        case "list":
          return {
            ...(await this.data<Record<string, unknown>>(command)),
            nativeStatus: { running: !this.ended, error: this.lastError },
          };
        case "detail": {
          const entry = await this.data<{ kind: string }>({ action: "entry", id: command.id });
          if (entry.kind === "image") {
            try {
              await this.ensurePng(command.id);
              await this.ensureThumbnail(command.id);
            } catch (error) {
              return {
                ...(await this.data<Record<string, unknown>>(command)),
                previewError: error instanceof Error ? error.message : String(error),
              };
            }
          }
          return this.data(command);
        }
        case "gallery.import": {
          if (!this.options.pickImages) throw new Error("图库图片选择尚未连接");
          const images = await this.options.pickImages();
          if (!accepts()) throw new Error("插件正在停止，请重新导入图片");
          if (images.length > 100) throw new Error("一次最多导入 100 张图片");
          const entries: unknown[] = [];
          for (const image of images) {
            const filename = confined(this.spool, `gallery-${randomUUID()}.png`);
            atomicWrite(filename, image.png);
            try {
              entries.push(
                await this.data({
                  action: "gallery.import",
                  file: filename,
                  name: image.name,
                  groupId: command.groupId,
                }),
              );
            } finally {
              fs.rmSync(filename, { force: true });
            }
          }
          result = entries;
          break;
        }
        case "copy":
        case "paste": {
          const mode = z.enum(["original", "text", "image-file"]).parse(command.mode ?? "original");
          if (mode === "image-file") await this.ensurePng(command.id);
          result = await this.restore(
            command.id,
            mode,
            command.action === "paste",
            false,
            targetVersion,
          );
          break;
        }
        case "emoji.copy":
          result = await this.restore(command.id, "text", false, true);
          break;
        case "settings":
          result = await this.data(command);
          if (command.patch) await this.configure();
          break;
        default:
          result = await this.data(command);
      }
      if (command.action !== "draft.save") this.notify();
      return result;
    });
  }
  async activate(activation: PluginActivation): Promise<JsonValue | undefined> {
    if (!activation.commandId) return undefined;
    if (activation.commandId === "history" || activation.commandId === "quick") {
      await this.options.openWorkspace?.({
        compact: activation.commandId === "quick",
        position: (await this.policy()).compactPosition,
      });
      return undefined;
    }
    if (activation.commandId === "pause")
      return (await this.request({
        action: "settings",
        patch: { paused: !(await this.policy()).paused },
      })) as JsonValue;
    throw new Error("Unknown clipboard command");
  }
  async prepareStop(_reason: StopReason): Promise<StopDecision> {
    try {
      if (_reason === "crash" && !this.options.backend.running) {
        // Freeze without asking a dead backend for settings or impossible ACKs.
        if (!this.ended) await this.rpc("configure", { paused: true, excludedApps: [] });
        this.frozenForStop = true;
        this.preserveSpool = true;
        const workspace = await this.options.prepareWorkspace?.();
        if (workspace && !workspace.ok) return workspace;
        await this.operations.catch(() => {});
        retainClipboardSpool({
          cacheDir: this.options.cacheDir,
          dataDir: this.options.dataDir,
          pluginId: this.owner.pluginId,
          sessionId: this.sessionId,
        });
        return { ok: true };
      }
      const workspace = await this.options.prepareWorkspace?.();
      if (workspace && !workspace.ok) return workspace;
      if (!this.ended) {
        await this.rpc("configure", {
          paused: true,
          excludedApps: (await this.policy()).excludedApps,
        });
        this.frozenForStop = true;
      }
      await this.operations.catch(() => {});
      await this.drain(true);
      await this.data({ action: "checkpoint" });
      return this.options.backend.prepareStop(_reason);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  async dispose() {
    if (this.closed) return;
    this.stopping = true;
    clearInterval(this.resumeTimer);
    if (!this.ended) {
      try {
        await this.rpc("stop");
      } catch (error) {
        if (!this.ended) throw error;
      }
    }
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        this.exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Clipboard helper did not exit normally; process remains tracked")),
            this.options.timeoutMs ?? 10000,
          );
        }),
      ]);
      if (code !== 0)
        this.lastError = `Clipboard helper exited (${code}); persisted history was retained`;
      await this.operations.catch(() => {});
      const pending = fs
        .readdirSync(this.spool)
        .some((file) => pendingSnapshot.test(file) || /^draft-[\da-f]+\.json$/.test(file));
      if (this.preserveSpool || pending)
        retainClipboardSpool({
          cacheDir: this.options.cacheDir,
          dataDir: this.options.dataDir,
          pluginId: this.owner.pluginId,
          sessionId: this.sessionId,
        });
      fs.rmSync(this.spool, { recursive: true, force: true });
      if (
        fs.existsSync(this.recovery) &&
        fs.readdirSync(this.recovery).every((file) => file === "owner.json")
      )
        fs.rmSync(this.recovery, { recursive: true });
      this.closed = true;
      this.queue = [];
    } finally {
      clearTimeout(timer);
    }
  }
  async abortStartup() {
    this.stopping = true;
    this.child.stdin.end();
    await this.dispose();
  }
}

export async function createClipboardRuntime(
  options: ClipboardRuntimeOptions,
): Promise<ClipboardRuntime> {
  if (!(await options.approveTrust()))
    throw new Error("Clipboard native execution requires host trust approval");
  const controller = new ClipboardController(options);
  try {
    await controller.initialize();
    return controller;
  } catch (error) {
    await controller.abortStartup();
    throw error;
  }
}
