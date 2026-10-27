import { utilityProcess, type UtilityProcess } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  PluginActivation,
  PluginOwner,
  StopReason,
  PluginDataMigration,
  PluginCapability,
} from "../../packages/sdk/src/index.js";
import type { BackendMessage, BackendRequest, BackendHostCall } from "./backend-worker.js";
import { AppError, confined, canonical } from "../persistence.js";
import { PluginResourceScope, samePluginOwner, type StopDecision } from "./resources.js";

export interface PluginBackendController {
  readonly owner: PluginOwner;
  readonly pid: number | undefined;
  readonly running: boolean;
  activate(activation: PluginActivation, signal?: AbortSignal): Promise<JsonValue | undefined>;
  /** Host-only final writes during an already owned save preparation. */
  maintenance(activation: PluginActivation): Promise<JsonValue | undefined>;
  prepareStop(reason: StopReason): Promise<StopDecision>;
  cancelStop(): Promise<void>;
  dispose(): Promise<void>;
}
export interface TrustedBackendOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  /** Absolute, validated manifest backend entry. */
  entryPath: string;
  dataDir: string;
  cacheDir: string;
  approveTrust: () => boolean | Promise<boolean>;
  onEvent?: (event: Extract<BackendMessage, { type: "event" }>) => void;
  onCrash?: (error: Error) => void;
  onLog?: (stream: "stdout" | "stderr", text: string) => void;
  onLogBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  timeoutMs?: number;
  /** Host policy for long business tasks; save/stop/init keep timeoutMs. */
  activationTimeoutMs?: (activation: PluginActivation) => number | undefined;
  /** A dedicated migration module, never the ordinary backend factory. */
  migration?: PluginDataMigration;
  startupCheckOnly?: boolean;
  hostCapabilities?: readonly PluginCapability[];
  /** Path has already been resolved against this instance's explicit data root. */
  onHostCall?: (
    call: BackendHostCall,
    context: { owner: PluginOwner; signal: AbortSignal },
  ) => Promise<void>;
}

// Reuse the manifest validator's resolved entry, then recheck at the execution
// boundary. Neither a renderer path nor a plugin-supplied shell command is accepted.
function verifiedEntry(root: string, entry: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(entry))
    throw new Error("Plugin execution requires validated absolute paths");
  const realRoot = fs.realpathSync(root),
    realEntry = fs.realpathSync(entry);
  const relative = path.relative(realRoot, realEntry);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !fs.statSync(realEntry).isFile()
  )
    throw new Error("Plugin entry is outside its verified package");
  return realEntry;
}

function waitWithTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

class UtilityBackend implements PluginBackendController {
  readonly owner: PluginOwner;
  private pending = new Map<
    string,
    {
      type: BackendRequest["type"];
      resolve: (value: JsonValue | undefined) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private exited = false;
  private disposing = false;
  private prepared = false;
  private disposed?: Promise<void>;
  private sessionRequestId?: string;
  private exitPromise: Promise<number>;
  private finishExit!: (code: number) => void;
  private hostCalls = new Map<string, AbortController>();

  constructor(
    private child: UtilityProcess,
    private options: TrustedBackendOptions,
  ) {
    this.owner = options.scope.owner;
    this.exitPromise = new Promise((resolve) => {
      this.finishExit = resolve;
    });
    child.on("message", (message: unknown) => this.receive(message));
    child.on("error", (type, location) => options.onLog?.("stderr", `${type}: ${location}`));
    child.once("exit", (code) => {
      this.exited = true;
      this.finishExit(code);
      const error = new Error(`Plugin backend exited (${code})`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      for (const controller of this.hostCalls.values()) controller.abort();
      this.hostCalls.clear();
      if (!this.disposing) options.onCrash?.(error);
    });
    for (const stream of ["stdout", "stderr"] as const)
      child[stream]?.on("data", (chunk: Buffer) => {
        if (options.scope.accepts(this.owner)) {
          try {
            options.onLogBytes?.(stream, chunk.length);
          } catch {
            /* Numeric observation only. */
          }
        }
        options.onLog?.(stream, String(chunk));
      });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  get running(): boolean {
    return !this.exited;
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const response = message as BackendMessage;
    if (
      !response.owner ||
      typeof response.requestId !== "string" ||
      !samePluginOwner(this.owner, response.owner)
    )
      return;
    if (response.type === "host-call") {
      void this.receiveHostCall(response);
      return;
    }
    if (response.type === "event") {
      if (
        !this.options.scope.accepts(response.owner) ||
        (response.requestId !== this.sessionRequestId && !this.pending.has(response.requestId))
      )
        return;
      this.options.onEvent?.(response);
      return;
    }
    if (response.type !== "response") return;
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    clearTimeout(request.timer);
    if (request.type === "activate" && !this.options.scope.accepts(response.owner)) {
      request.reject(new Error("Stale plugin backend response"));
      return;
    }
    if (response.ok) request.resolve(response.value);
    else
      request.reject(
        response.code
          ? new AppError(response.code, response.error, response.details)
          : new Error(response.error),
      );
  }

  private async receiveHostCall(
    message: Extract<BackendMessage, { type: "host-call" }>,
  ): Promise<void> {
    if (this.hostCalls.has(message.callId)) return;
    const controller = new AbortController();
    try {
      if (
        !/^[a-f0-9-]{36}$/i.test(message.callId) ||
        this.hostCalls.size >= 32 ||
        this.exited ||
        this.disposing ||
        !this.options.scope.accepts(message.owner) ||
        this.pending.get(message.requestId)?.type !== "activate" ||
        !this.options.onHostCall ||
        !this.options.hostCapabilities?.includes("storage") ||
        !["file.trash", "storage.protectRoot"].includes(message.call?.operation) ||
        typeof message.call.path !== "string" ||
        message.call.path.length > 32768
      )
        throw new AppError("permissionDenied", "Backend platform action is not authorized");
      let call: BackendHostCall;
      if (message.call.operation === "file.trash") {
        if (path.isAbsolute(message.call.path))
          throw new AppError("permissionDenied", "Trash requires a relative owned path");
        const file = confined(this.options.dataDir, message.call.path);
        if (file === canonical(this.options.dataDir) || !fs.lstatSync(file).isFile())
          throw new AppError("permissionDenied", "Trash requires an owned regular file");
        call = { operation: "file.trash", path: file };
      } else {
        if (
          !path.isAbsolute(message.call.path) ||
          path.resolve(message.call.path) === path.parse(message.call.path).root
        )
          throw new AppError(
            "permissionDenied",
            "Private data protection requires an explicit directory",
          );
        // No filesystem authority is granted here. Main must bind this planned
        // root to its pending, user-authorized migration before registering it.
        call = { operation: "storage.protectRoot", path: canonical(message.call.path) };
      }
      this.hostCalls.set(message.callId, controller);
      await this.options.onHostCall(call, { owner: this.owner, signal: controller.signal });
      if (!this.options.scope.accepts(message.owner) || controller.signal.aborted)
        throw new AppError("pluginDisabled", "Platform result belongs to an expired owner");
      if (!this.exited)
        this.child.postMessage({
          type: "host-reply",
          owner: this.owner,
          requestId: message.requestId,
          callId: message.callId,
          ok: true,
        });
    } catch (error) {
      if (!this.exited)
        this.child.postMessage({
          type: "host-reply",
          owner: this.owner,
          requestId: message.requestId,
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      this.hostCalls.delete(message.callId);
    }
  }

  private rpc(
    message: BackendRequest,
    timeoutMs = this.options.timeoutMs ?? 10_000,
    cancellation?: { signal: AbortSignal; cancel: () => void },
  ): Promise<JsonValue | undefined> {
    if (this.exited) return Promise.reject(new Error("Plugin backend is no longer running"));
    const result = new Promise<JsonValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        if (message.type === "activate") {
          try {
            this.child.postMessage({
              type: "cancel",
              owner: this.owner,
              requestId: message.requestId,
            });
          } catch {
            // Exit may race a timeout; the caller must still receive its timeout.
          }
        }
        reject(new Error(`Plugin backend ${message.type} timed out`));
      }, timeoutMs);
      this.pending.set(message.requestId, { type: message.type, resolve, reject, timer });
      // Registration follows pending ownership so even an already-aborted signal
      // releases this RPC. Never send an activation after cancellation wins.
      cancellation?.signal.addEventListener("abort", cancellation.cancel, { once: true });
      if (cancellation?.signal.aborted) {
        cancellation.cancel();
        return;
      }
      try {
        this.child.postMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return result.finally(() =>
      cancellation?.signal.removeEventListener("abort", cancellation.cancel),
    );
  }

  async initialize(entryPath: string): Promise<void> {
    this.sessionRequestId = randomUUID();
    const result = await this.rpc({
      type: "init",
      owner: this.owner,
      requestId: this.sessionRequestId,
      entryPath,
      dataDir: this.options.dataDir,
      cacheDir: this.options.cacheDir,
      startupCheckOnly: this.options.startupCheckOnly ?? false,
      ...(this.options.migration ? { migration: this.options.migration } : {}),
    });
    if (
      this.options.migration &&
      (!result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        result.dataVersion !== this.options.migration.toDataVersion)
    )
      throw new Error("Migration did not acknowledge the requested data version");
  }

  async activate(
    activation: PluginActivation,
    signal?: AbortSignal,
  ): Promise<JsonValue | undefined> {
    signal?.throwIfAborted();
    if (this.options.scope.state !== "active" || this.disposing)
      throw new Error("Plugin backend is not accepting commands");
    this.prepared = false;
    const requestId = randomUUID();
    const release = this.options.scope.own("task", {
      dispose: () => {
        const request = this.pending.get(requestId);
        if (!request) return;
        this.pending.delete(requestId);
        clearTimeout(request.timer);
        try {
          if (!this.exited)
            this.child.postMessage({ type: "cancel", owner: this.owner, requestId });
        } finally {
          request.reject(new Error("Plugin task cancelled"));
        }
      },
    });
    try {
      return await this.rpc(
        { type: "activate", owner: this.owner, requestId, activation },
        this.options.activationTimeoutMs?.(activation),
        signal ? { signal, cancel: () => void release().catch(() => {}) } : undefined,
      );
    } finally {
      await release();
    }
  }

  async maintenance(activation: PluginActivation): Promise<JsonValue | undefined> {
    if (this.options.scope.state !== "preparing" || this.disposing || this.exited)
      throw new Error("Backend maintenance writes require active save preparation");
    this.prepared = false;
    return this.rpc({ type: "activate", owner: this.owner, requestId: randomUUID(), activation });
  }

  async prepareStop(reason: StopReason): Promise<StopDecision> {
    this.prepared = false;
    if (this.exited)
      return reason === "crash"
        ? { ok: true }
        : { ok: false, reason: "Backend exited before save confirmation" };
    try {
      const decision = await this.rpc({
        type: "prepareStop",
        owner: this.owner,
        requestId: randomUUID(),
        reason,
      });
      if (
        !decision ||
        typeof decision !== "object" ||
        Array.isArray(decision) ||
        typeof decision.ok !== "boolean"
      )
        throw new Error("Invalid backend save confirmation");
      this.prepared = decision.ok;
      return decision.ok
        ? { ok: true }
        : {
            ok: false,
            reason:
              typeof decision.reason === "string" ? decision.reason : "Backend refused shutdown",
          };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancelStop(): Promise<void> {
    if (this.exited || this.disposing) throw new Error("Backend cannot resume after preparation");
    this.prepared = false;
    await this.rpc({ type: "cancelStop", owner: this.owner, requestId: randomUUID() });
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.disposed;
    if (this.exited) return Promise.resolve();
    if (!this.prepared)
      return Promise.reject(new Error("Backend requires successful prepareStop before disposal"));
    this.disposing = true;
    const operation = (async () => {
      await this.rpc({ type: "stop", owner: this.owner, requestId: randomUUID() });
      this.child.postMessage({ type: "exit", owner: this.owner, requestId: randomUUID() });
      const code = await waitWithTimeout(
        this.exitPromise,
        this.options.timeoutMs ?? 10_000,
        "Backend did not exit after saved shutdown",
      );
      if (code !== 0) throw new Error(`Backend shutdown exited (${code})`);
    })().catch((error) => {
      this.disposed = undefined;
      throw error;
    });
    this.disposed = operation;
    return operation;
  }

  async abortFailedStartup(): Promise<void> {
    // A failed launch is reported as failure; termination is never a save acknowledgement.
    this.disposing = true;
    if (!this.exited) this.child.kill();
    await waitWithTimeout(
      this.exitPromise,
      this.options.timeoutMs ?? 10_000,
      "Failed backend startup left a running process",
    );
  }
}

export async function createTrustedBackend(
  options: TrustedBackendOptions,
): Promise<PluginBackendController> {
  if (!(await options.approveTrust()))
    throw new Error("Host trust approval is required for Node backends");
  const entryPath = verifiedEntry(options.pluginRoot, options.entryPath);
  if (options.scope.state !== "active") throw new Error("Plugin scope is not active");
  fs.mkdirSync(options.dataDir, { recursive: true });
  fs.mkdirSync(options.cacheDir, { recursive: true });
  const child = utilityProcess.fork(
    fileURLToPath(new URL("./backend-worker.js", import.meta.url)),
    [],
    {
      cwd: options.pluginRoot,
      stdio: "pipe",
      serviceName: `spark233:${options.scope.owner.pluginId}:${options.scope.owner.instanceId}`,
    },
  );
  const controller = new UtilityBackend(child, options);
  const release = options.scope.own("process", {
    prepareStop: (reason) => controller.prepareStop(reason),
    cancelStop: () => controller.cancelStop(),
    dispose: () => controller.dispose(),
  });
  try {
    await controller.initialize(entryPath);
    return controller;
  } catch (error) {
    await controller.abortFailedStartup();
    await release();
    throw error;
  }
}

export interface NativeProcessExit {
  owner: PluginOwner;
  requestId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}
export interface TrustedNativeOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  /** Descriptor resolved from the validated manifest, with immutable manifest arguments. */
  descriptor: { path: string; args: string[] };
  approveTrust: () => boolean | Promise<boolean>;
  prepareStop?: (reason: StopReason) => StopDecision | Promise<StopDecision>;
  requestShutdown?: () => void | Promise<void>;
  onOutputBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  onOutput?: (output: {
    owner: PluginOwner;
    requestId: string;
    stream: "stdout" | "stderr";
    text: string;
  }) => void;
  timeoutMs?: number;
  /** Raw process diagnostics remain available while result consumers are fenced. */
  onExit?: (exit: NativeProcessExit) => void;
}
export interface PluginNativeController {
  readonly owner: PluginOwner;
  readonly requestId: string;
  readonly pid: number | undefined;
  prepareStop(reason: StopReason): Promise<StopDecision>;
  waitForExit(): Promise<NativeProcessExit>;
  dispose(): Promise<void>;
}

export async function createTrustedNativeProcess(
  options: TrustedNativeOptions,
): Promise<PluginNativeController> {
  if (!(await options.approveTrust()))
    throw new Error("Host trust approval is required for native plugins");
  const executable = verifiedEntry(options.pluginRoot, options.descriptor.path);
  if (options.scope.state !== "active") throw new Error("Plugin scope is not active");
  const owner = options.scope.owner,
    requestId = randomUUID();
  const child: ChildProcessWithoutNullStreams = spawn(executable, options.descriptor.args.slice(), {
    cwd: options.pluginRoot,
    shell: false,
    windowsHide: true,
    stdio: "pipe",
  });
  let ended = false,
    prepared = false,
    failure: string | undefined;
  const completion = new Promise<NativeProcessExit>((resolve) => {
    child.once("error", (error) => {
      failure = error.message;
    });
    child.once("close", (code, signal) => {
      ended = true;
      const result = { owner, requestId, code, signal, ...(failure ? { error: failure } : {}) };
      try {
        options.onExit?.(result);
      } catch (error) {
        console.error("native-exit-diagnostic", error);
      }
      resolve(result);
    });
  });
  for (const stream of ["stdout", "stderr"] as const)
    child[stream].on("data", (chunk: Buffer) => {
      if (options.scope.accepts(owner)) {
        try {
          options.onOutputBytes?.(stream, chunk.length);
        } catch {
          /* Never affect protocol/lifecycle. */
        }
        options.onOutput?.({ owner, requestId, stream, text: String(chunk) });
      }
    });
  const controller: PluginNativeController = {
    owner,
    requestId,
    get pid() {
      return child.pid;
    },
    async prepareStop(reason) {
      if (ended) {
        prepared = true;
        return { ok: true };
      }
      const decision = (await options.prepareStop?.(reason)) ?? {
        ok: false as const,
        reason: "Running native process requires adapter save confirmation",
      };
      prepared = decision.ok;
      return decision;
    },
    async waitForExit() {
      const result = await completion;
      if (!options.scope.accepts(owner)) throw new Error("Stale native process result");
      return result;
    },
    async dispose() {
      if (ended) return;
      if (!prepared) throw new Error("Native process has not acknowledged saved shutdown");
      if (!options.requestShutdown)
        throw new Error("Native process needs a graceful shutdown adapter");
      await options.requestShutdown();
      await waitWithTimeout(
        completion,
        options.timeoutMs ?? 10_000,
        "Native process did not exit; it remains tracked",
      );
    },
  };
  const release = options.scope.own("process", {
    prepareStop: (reason) => controller.prepareStop(reason),
    dispose: () => controller.dispose(),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await completion;
    await release();
    throw error;
  }
  return controller;
}
